// server.js
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = 3000;

// -------------------- LOAD MLS CSV --------------------
let mlsRows = [];
let mlsColumns = [];

try {
  const raw = fs.readFileSync('./data/Active Listings.csv', 'utf8');

  // Some exports have a bogus first header like "Full-4"
  const fixedRaw = raw.startsWith('Full-4')
    ? raw.split('\n').slice(1).join('\n')
    : raw;

  const records = parse(fixedRaw, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });

  if (!records.length) {
    console.warn('⚠️ CSV loaded but has 0 data rows');
  }

  mlsRows = records;
  mlsColumns = Object.keys(records[0] || {});

  console.log(
    `✅ Loaded MLS file with ${mlsRows.length} rows and ${mlsColumns.length} columns`
  );
  console.log('First columns:', mlsColumns.slice(0, 20).join(', ') + '...');
} catch (err) {
  console.error('❌ Error loading CSV:', err.message);
}

// -------------------- EXPRESS SETUP --------------------
app.use(express.json());
app.use(express.static('public'));

// -------------------- IN-MEMORY CONVERSATION STATE --------------------
let lastList = [];      // [{ rowIndex, displayAddress }]
let lastListing = null; // { rowIndex, displayAddress }

// -------------------- HELPER FUNCTIONS --------------------
function formatAddress(row) {
  const num = row.StreetNumberNumeric || row.StreetNumber || '';
  const dirPre = row.StreetDirPrefix || '';
  const name = row.StreetName || '';
  const suffix = row.StreetSuffix || '';
  const city = row.City || '';
  const state = row.StateOrProvince || 'CA';
  const zip = row.PostalCode || '';
  const parts = [
    [num, dirPre, name, suffix].filter(Boolean).join(' '),
    city,
    state,
    zip,
  ].filter(Boolean);
  return parts.join(', ');
}

function formatBedsBaths(row) {
  const beds = row.BedroomsTotal || row.Bedrooms || null;
  let baths =
    row.BathroomsTotalInteger ||
    row.BathroomsFull ||
    row.Bathrooms ||
    null;

  if (!row.BathroomsTotalInteger) {
    const full = Number(row.BathroomsFull || 0);
    const threeQuarter = Number(row.BathroomsThreeQuarter || 0);
    const half = Number(row.BathroomsHalf || 0);
    const quarter = Number(row.BathroomsOneQuarter || 0);
    const est = full + threeQuarter * 0.75 + half * 0.5 + quarter * 0.25;
    if (est > 0) baths = est;
  }

  const bedsText = beds != null && beds !== '' ? `${beds} beds` : 'beds N/A';
  const bathsText =
    baths != null && baths !== ''
      ? `${baths} baths`
      : 'baths N/A';

  return { beds, baths, text: `${bedsText}, ${bathsText}` };
}

function formatPrice(row) {
  const priceRaw = row.ListPrice || row.CurrentPrice;
  if (!priceRaw) return 'Price not in CSV';
  const num = Number(priceRaw);
  if (Number.isNaN(num)) return String(priceRaw);
  return '$' + num.toLocaleString();
}

function formatLoanTerms(row) {
  const terms = row.ListingTerms || row.LoanPayment || '';
  return terms || 'Loan/financing terms not specified in CSV.';
}

function formatSqft(row) {
  const sqft =
    row.LivingArea ||
    row.BuildingAreaTotal ||
    row.ResidentialSquareFootage ||
    row.TotalBuildingNRA;
  if (!sqft) return 'Square footage not in CSV.';
  const num = Number(sqft);
  if (Number.isNaN(num)) return `${sqft} sq ft (raw)`;
  return `${num.toLocaleString()} sq ft`;
}

function formatDescription(row) {
  const pub = (row.PublicRemarks || '').trim();
  const priv = (row.PrivateRemarks || '').trim();
  const parts = [];
  if (pub) parts.push(`Public remarks: ${pub}`);
  if (priv) parts.push(`Private remarks: ${priv}`);
  if (!parts.length) return 'No remarks available in the CSV for this listing.';
  return parts.join('\n\n');
}

function formatAgent(row) {
  const first = row.ListAgentFirstName || '';
  const last = row.ListAgentLastName || '';
  const name = (first + ' ' + last).trim() || 'Listing agent not in CSV';
  return name;
}

function formatAgentContact(row) {
  const name = formatAgent(row);
  const mobile = row.ListAgentMobilePhone || row.CoListAgentMobilePhone || '';
  const direct = row.ListAgentDirectPhone || '';
  const email = row.ListAgentEmail || '';
  const office = row.ListOfficeName || '';
  const officePhone = row.ListOfficePhone || '';

  const lines = [`Agent: ${name}`];
  if (mobile) lines.push(`Mobile: ${mobile}`);
  if (direct && direct !== mobile) lines.push(`Direct: ${direct}`);
  if (email) lines.push(`Email: ${email}`);
  if (office) lines.push(`Office: ${office}`);
  if (officePhone) lines.push(`Office phone: ${officePhone}`);

  return lines.join('\n');
}

// Full raw row (clean, only non-empty fields)
function formatFullRow(row) {
  const lines = [];
  for (const col of mlsColumns) {
    const val = row[col];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      lines.push(`${col}: ${val}`);
    }
  }
  if (!lines.length) return 'No data available for this listing row.';
  return lines.join('\n');
}

// Look up listing by index from last list (#1, #2, etc.)
function getListingByIndex(idx) {
  if (!lastList.length) return null;
  const item = lastList[idx - 1];
  if (!item) return null;
  return {
    rowIndex: item.rowIndex,
    row: mlsRows[item.rowIndex],
    displayAddress: item.displayAddress,
  };
}

// Look up by address-ish string (very fuzzy)
function findListingByAddressLike(text) {
  if (!text) return null;
  const needle = text.toLowerCase().replace(/\s+/g, ' ').trim();

  let best = null;

  mlsRows.forEach((row, i) => {
    const addr = formatAddress(row).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!addr) return;
    if (addr.includes(needle)) {
      if (!best || addr.length < best.addr.length) {
        best = { rowIndex: i, row, addr: formatAddress(row) };
      }
    }
  });

  if (!best) return null;
  return {
    rowIndex: best.rowIndex,
    row: best.row,
    displayAddress: best.addr,
  };
}

// Filter helpers for list queries
function filterRowsForList({ city, maxPrice, minBeds, loanTermsIncludes }) {
  const cityNeedle = city ? city.toLowerCase() : null;
  const loanNeedle = loanTermsIncludes
    ? loanTermsIncludes.toLowerCase()
    : null;

  return mlsRows.filter((row) => {
    if (cityNeedle) {
      const rowCity = (row.City || '').toLowerCase();
      if (!rowCity.includes(cityNeedle)) return false;
    }

    if (maxPrice != null) {
      const pRaw = row.ListPrice || row.CurrentPrice;
      const pNum = Number(pRaw);
      if (!pRaw || Number.isNaN(pNum) || pNum > maxPrice) return false;
    }

    if (minBeds != null) {
      const b = Number(row.BedroomsTotal || row.Bedrooms || 0);
      if (Number.isNaN(b) || b < minBeds) return false;
    }

    if (loanNeedle) {
      const terms = (row.ListingTerms || '').toLowerCase();
      if (!terms.includes(loanNeedle)) return false;
    }

    return true;
  });
}

// Create a numbered list + update lastList, with optional extra fields per row
function formatListOutput(rows, { limit = 50, fields = [] } = {}) {
  const fieldsLower = (fields || []).map((f) => String(f).toLowerCase());
  const wantsAllData =
    fieldsLower.includes('all_data') ||
    fieldsLower.includes('full_profile') ||
    fieldsLower.includes('all_info') ||
    fieldsLower.includes('full_property_profile');

  // If they want EVERYTHING for each listing, cap at 10 to keep it readable.
  const effectiveLimit = wantsAllData ? Math.min(limit, 10) : limit;

  const limited = rows.slice(0, effectiveLimit);
  lastList = limited.map((row, idx) => ({
    rowIndex: mlsRows.indexOf(row),
    displayAddress: formatAddress(row),
  }));

  if (!limited.length) {
    return 'There are 0 listings that match your criteria.';
  }

  const lines = limited.map((row, i) => {
    const address = formatAddress(row);
    const base = `#${i + 1} ${address}`;

    if (!fieldsLower.length) return base;

    const extras = [];

    if (fieldsLower.includes('price')) {
      extras.push(`Price: ${formatPrice(row)}`);
    }
    if (fieldsLower.includes('beds') || fieldsLower.includes('baths')) {
      const { text } = formatBedsBaths(row);
      extras.push(text);
    }
    if (
      fieldsLower.includes('loan_terms') ||
      fieldsLower.includes('terms') ||
      fieldsLower.includes('financing')
    ) {
      extras.push(`Loan terms: ${formatLoanTerms(row)}`);
    }

    if (
      fieldsLower.includes('description') ||
      fieldsLower.includes('remarks')
    ) {
      const pub = (row.PublicRemarks || '').trim();
      const priv = (row.PrivateRemarks || '').trim();
      const desc =
        pub || priv
          ? (pub ? `Public: ${pub}` : '') +
            (pub && priv ? ' | ' : '') +
            (priv ? `Private: ${priv}` : '')
          : 'No remarks in CSV.';
      extras.push(desc);
    }

    if (wantsAllData) {
      extras.push('\n' + formatFullRow(row));
    }

    if (!extras.length) return base;
    return `${base} — ${extras.join(' | ')}`;
  });

  return `Here are up to ${limited.length} matching listings:\n` + lines.join('\n');
}

// -------------------- OPENAI PLANNER PROMPT --------------------
const plannerSystemPrompt = `
You are a planner for "Realtor GPT". 
Your job: look at the conversation and return a SINGLE JSON object describing what the user wants.
The Node server will actually read the MLS CSV and answer.

MLS CSV facts:
- Each row = one listing.
- Important columns include:
  - Address pieces: StreetNumber, StreetNumberNumeric, StreetDirPrefix, StreetName, StreetSuffix, City, StateOrProvince, PostalCode
  - BedroomsTotal
  - BathroomsTotalInteger (plus bathrooms component columns)
  - ListPrice, CurrentPrice
  - ListingTerms  (ex: "1031 Exchange, Cash, Cash to New Loan, Conventional, VA Loan")
  - PublicRemarks, PrivateRemarks
  - LivingArea, BuildingAreaTotal, ResidentialSquareFootage
  - ListAgentFirstName, ListAgentLastName, ListAgentMobilePhone, ListAgentDirectPhone, ListAgentEmail, ListOfficeName, ListOfficePhone

In this app, **"property description" ALWAYS means: 
PublicRemarks + PrivateRemarks, formatted nicely.**

The server keeps:
- A "last list" of results that it printed like "#1 ...", "#2 ...", etc.
- A "lastListing" for the most recently discussed single listing.

### Your output format

Return ONLY a JSON object (no prose) with this structure:

{
  "intent": string,     // REQUIRED
  "city": string | null,
  "maxPrice": number | null,
  "minBeds": number | null,
  "loanTermsIncludes": string | null,
  "index": number | null,        // single index (#11, 11, "listing 11")
  "indices": number[] | null,    // multiple indices (e.g. 33-35, 33 and 34)
  "lastN": number | null,        // "last 10", "last 5" etc.
  "countOnly": boolean | null,   // "how many listings ..."
  "fields": string[] | null,     // WHAT INFO they want (for lists OR single listing)
  "useLastListing": boolean | null  // true if "it", "them", "that one", "this property", etc.
}

Allowed intent values (choose ONE):

- "list_addresses_by_city"
- "list_addresses_with_remarks"
- "filtered_list_by_city_price_beds"
- "listing_agent_for_index"
- "listing_agent_for_address"
- "beds_baths_for_index"
- "beds_baths_for_address"
- "loan_terms_for_index"
- "loan_terms_for_address"
- "description_for_index"
- "description_for_address"
- "details_for_index"
- "details_for_address"
- "average_price_by_city"
- "full_profile_for_index"
- "full_profile_for_address"
- "full_profile_about_last_listing"
- "followup_about_last_listing"
- "small_talk"
- "unknown"

### Rules

- If the user refers to "#11", "11", "number 11", "listing 11", etc. -> set "index" = 11.
- If they mention a range like "33-34" -> indices = [33, 34].
- If they say "last 10" or "for the last 10" -> lastN = 10.
- If the message is JUST a number like "11" or "#11", they want **"details_for_index"** for that index.
- If they say "property description for 11" or "#11" -> intent = "description_for_index".
- "property description" ALWAYS refers to public + private remarks.
- "beds", "bedrooms" -> BedroomsTotal.
- "baths", "bathrooms" -> BathroomsTotalInteger.
- "loan terms", "financing", "FHA / VA / Conventional" -> ListingTerms column.
- Words like "FHA", "VA", "Conventional" -> loanTermsIncludes = "FHA" etc.

- If they say things like:
  - "what's the average price for houses in San Fernando"
  - "average price of all homes in San Fernando"
  -> intent = "average_price_by_city", with city = "San Fernando".

- If they say "full rundown", "full profile", "all info", "all data", "full property profile":
  - and they are clearly talking about ONE listing (by #, address, or pronoun like "it"):
      -> use "full_profile_for_index", "full_profile_for_address", or "full_profile_about_last_listing".
  - and they are asking for a LIST (e.g. "show me a list of all properties in San Fernando with all data", "full property profiles for San Fernando"):
      -> intent = "list_addresses_by_city", city set, fields = ["all_data"].

### fields usage

Use "fields" to specify WHAT extra info is wanted:

For **list intents**:
- "show me addresses in San Fernando with price next to them"
  -> intent = "list_addresses_by_city", city = "San Fernando", fields = ["price"]
- "addresses in San Fernando with beds and baths next to them"
  -> intent = "list_addresses_by_city", fields = ["beds","baths"]
- "addresses with price and loan terms"
  -> intent = "list_addresses_by_city", fields = ["price","loan_terms"]
- "list with all data" / "full property profiles"
  -> intent = "list_addresses_by_city", fields = ["all_data"]

For **followups about a single listing**:
- "its price" -> fields = ["price"]
- "its agent" -> fields = ["agent"]
- "its property description" -> fields = ["description"]
- "its address" -> fields = ["address"]
- "its square footage" -> fields = ["square_footage"]
- "its contact info" -> fields = ["contact_info"]
- "its full profile" / "all data" / "all info" -> fields = ["all_data"]

For **filtered lists**:
- "show me addresses under 900k with 3 bedrooms in San Fernando"
    -> intent = "filtered_list_by_city_price_beds"
       city = "San Fernando", maxPrice = 900000, minBeds = 3
- "show me addresses in San Fernando that accept FHA"
    -> intent = "filtered_list_by_city_price_beds"
       city = "San Fernando", loanTermsIncludes = "FHA"

- For "all details for 33-35" or "give me beds and baths for 33-34":
    intent = "details_for_index" or "beds_baths_for_index"
    indices = [33,34]

- Never include explanations or comments. Only output valid JSON.
`;

// -------------------- CHAT ENDPOINT --------------------
app.post('/api/chat', async (req, res) => {
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const lastUserMsg =
    [...history].reverse().find((m) => m.role === 'user') || {};
  const userText = (lastUserMsg.content || '').trim();

  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ error: 'OPENAI_API_KEY is missing in .env' });
  }

  // Simple greeting short-circuit
  if (/^\s*(hi|hello|hey|hola)\s*$/i.test(userText)) {
    return res.json({
      reply:
        "Hey! I'm Realtor GPT. I can search your MLS CSV. For example, try:\n\n" +
        '• "show me all addresses in San Fernando"\n' +
        '• "show me addresses under 900k with 3 beds in San Fernando"\n' +
        '• "#11" (to see full details for listing 11)\n' +
        '• "what is the average price for houses in San Fernando?"',
    });
  }

  // Ask OpenAI to create a small intent JSON
  let plan;
  try {
    const plannerMessages = [
      { role: 'system', content: plannerSystemPrompt },
      ...history,
    ];

    const response = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: plannerMessages,
          response_format: { type: 'json_object' },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      console.error('OpenAI planner error:', data);
      return res
        .status(500)
        .json({ error: data.error?.message || 'OpenAI API error' });
    }

    const content = data.choices?.[0]?.message?.content || '{}';
    plan = JSON.parse(content);
    console.log('📝 Planner intent:', JSON.stringify(plan, null, 2));
  } catch (err) {
    console.error('Failed to get/parse planner output:', err);
    return res.status(500).json({ error: 'Failed to interpret query.' });
  }

  // Default values
  const intent = plan.intent || 'unknown';
  const city = plan.city || null;
  const maxPrice = plan.maxPrice ?? null;
  const minBeds = plan.minBeds ?? null;
  const loanTermsIncludes = plan.loanTermsIncludes || null;
  const index = plan.index ?? null;
  const indices = Array.isArray(plan.indices) ? plan.indices : null;
  const lastN = plan.lastN ?? null; // not used yet, but kept for future
  const countOnly = !!plan.countOnly;
  const fields = Array.isArray(plan.fields) ? plan.fields : null;
  const useLastListing = !!plan.useLastListing;

  let reply = '';

  function ensureListingForIndex(idx) {
    const listing = getListingByIndex(idx);
    if (!listing) {
      return { error: `I don't have a listing #${idx} in the last list.` };
    }
    lastListing = listing; // remember for follow-ups
    return { listing };
  }

  try {
    switch (intent) {
      // ---------- LISTING LIST INTENTS ----------
      case 'list_addresses_by_city': {
        const rows = filterRowsForList({ city });
        const listFields = fields || [];
        const wantsAllData = (listFields || [])
          .map((f) => String(f).toLowerCase())
          .includes('all_data');
        const limit = wantsAllData ? 10 : 100;

        if (countOnly) {
          reply = `There are ${rows.length} listings that match your criteria.`;
        } else {
          reply = formatListOutput(rows, {
            limit,
            fields: listFields,
          });
        }
        break;
      }

      case 'list_addresses_with_remarks': {
        const rows = filterRowsForList({ city });
        const limited = rows.slice(0, 50);

        lastList = limited.map((row, idx) => ({
          rowIndex: mlsRows.indexOf(row),
          displayAddress: formatAddress(row),
        }));

        if (!limited.length) {
          reply = 'There are 0 listings that match your criteria.';
          break;
        }

        const lines = limited.map((row, i) => {
          const addr = formatAddress(row);
          const pub = (row.PublicRemarks || '').trim();
          const priv = (row.PrivateRemarks || '').trim();
          const descLines = [];
          if (pub) descLines.push(`Public remarks: ${pub}`);
          if (priv) descLines.push(`Private remarks: ${priv}`);
          const desc = descLines.join(' | ') || 'No remarks in CSV.';
          return `#${i + 1} ${addr}\n  ${desc}`;
        });

        reply =
          `Here are up to ${limited.length} matching listings:\n` +
          lines.join('\n\n');
        break;
      }

      case 'filtered_list_by_city_price_beds': {
        const rows = filterRowsForList({
          city,
          maxPrice,
          minBeds,
          loanTermsIncludes,
        });

        const listFields = fields || [];
        const wantsAllData = (listFields || [])
          .map((f) => String(f).toLowerCase())
          .includes('all_data');
        const limit = wantsAllData ? 10 : 100;

        if (countOnly) {
          reply = `There are ${rows.length} listings that match your criteria.`;
        } else {
          reply = formatListOutput(rows, {
            limit,
            fields: listFields,
          });
        }
        break;
      }

      // ---------- AVERAGE PRICE ----------
      case 'average_price_by_city': {
        const rows = filterRowsForList({ city });

        const prices = rows
          .map((row) => Number(row.ListPrice || row.CurrentPrice))
          .filter((n) => !Number.isNaN(n) && n > 0);

        if (!prices.length) {
          reply =
            'I could not find any valid prices in the CSV for that city.';
          break;
        }

        const sum = prices.reduce((a, b) => a + b, 0);
        const avg = sum / prices.length;

        reply =
          `For ${city || 'the selected area'}, I found ${prices.length} listings with prices.\n` +
          `Average price: $${Math.round(avg).toLocaleString()}.`;
        break;
      }

      // ---------- DETAILS FOR INDICES / ADDRESSES ----------
      case 'details_for_index': {
        const idxs =
          indices && indices.length
            ? indices
            : index != null
            ? [index]
            : [];

        if (!idxs.length) {
          reply =
            "I couldn't tell which listing number you meant. Try something like '#11' or 'details for 11'.";
          break;
        }

        const chunks = [];

        for (const idx of idxs) {
          const { listing, error } = ensureListingForIndex(idx);
          if (error) {
            chunks.push(error);
            continue;
          }
          const row = listing.row;
          const addr = listing.displayAddress || formatAddress(row);
          const { text: bedsBathsText } = formatBedsBaths(row);
          const priceText = formatPrice(row);
          const description = formatDescription(row);
          const loanTerms = formatLoanTerms(row);
          const sqft = formatSqft(row);
          const agent = formatAgent(row);

          chunks.push(
            `#${idx} ${addr}\n` +
              `Price: ${priceText}\n` +
              `Beds/Baths: ${bedsBathsText}\n` +
              `Square footage: ${sqft}\n` +
              `Loan terms: ${loanTerms}\n` +
              `Listing agent: ${agent}\n` +
              `Property description:\n${description}`
          );
        }

        reply = chunks.join('\n\n');
        break;
      }

      case 'details_for_address': {
        const listing = findListingByAddressLike(userText);
        if (!listing) {
          reply =
            "I couldn't match that address to any listing in the CSV. Try copying the address as it appears in the list.";
          break;
        }
        lastListing = listing;

        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const { text: bedsBathsText } = formatBedsBaths(row);
        const priceText = formatPrice(row);
        const description = formatDescription(row);
        const loanTerms = formatLoanTerms(row);
        const sqft = formatSqft(row);
        const agent = formatAgent(row);

        reply =
          `${addr}\n` +
          `Price: ${priceText}\n` +
          `Beds/Baths: ${bedsBathsText}\n` +
          `Square footage: ${sqft}\n` +
          `Loan terms: ${loanTerms}\n` +
          `Listing agent: ${agent}\n` +
          `Property description:\n${description}`;
        break;
      }

      // ---------- FULL PROFILE (ALL DATA) ----------
      case 'full_profile_for_index': {
        if (index == null) {
          reply = "I couldn't tell which listing number you meant.";
          break;
        }
        const { listing, error } = ensureListingForIndex(index);
        if (error) {
          reply = error;
          break;
        }
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        lastListing = listing;

        reply =
          `Full profile for #${index} ${addr}:\n\n` + formatFullRow(row);
        break;
      }

      case 'full_profile_for_address': {
        const listing = findListingByAddressLike(userText);
        if (!listing) {
          reply =
            "I couldn't match that address to any listing in the CSV. Try copying the address as it appears in the list.";
          break;
        }
        lastListing = listing;
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);

        reply = `Full profile for ${addr}:\n\n` + formatFullRow(row);
        break;
      }

      case 'full_profile_about_last_listing': {
        if (!lastListing) {
          reply =
            "I'm not sure which property you mean by 'it'. Ask about a specific listing first (for example, '#11').";
          break;
        }
        const row = lastListing.row;
        const addr = lastListing.displayAddress || formatAddress(row);

        reply = `Full profile for ${addr}:\n\n` + formatFullRow(row);
        break;
      }

      // ---------- BED / BATH ----------
      case 'beds_baths_for_index': {
        const idxs =
          indices && indices.length
            ? indices
            : index != null
            ? [index]
            : [];

        if (!idxs.length) {
          reply = "I couldn't tell which listing number you meant.";
          break;
        }

        const parts = [];
        for (const idx of idxs) {
          const { listing, error } = ensureListingForIndex(idx);
          if (error) {
            parts.push(error);
            continue;
          }
          const row = listing.row;
          const addr = listing.displayAddress || formatAddress(row);
          const { text } = formatBedsBaths(row);
          parts.push(`#${idx} ${addr} — ${text}`);
        }

        reply = parts.join('\n');
        break;
      }

      case 'beds_baths_for_address': {
        const listing = findListingByAddressLike(userText);
        if (!listing) {
          reply =
            "I couldn't match that address to any listing in the CSV. Try copying the address as it appears in the list.";
          break;
        }
        lastListing = listing;
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const { text } = formatBedsBaths(row);
        reply = `${addr} — ${text}`;
        break;
      }

      // ---------- AGENT ----------
      case 'listing_agent_for_index': {
        if (index == null) {
          reply = "I couldn't tell which listing number you meant.";
          break;
        }
        const { listing, error } = ensureListingForIndex(index);
        if (error) {
          reply = error;
          break;
        }
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const agentContact = formatAgentContact(row);
        reply = `#${index} ${addr}\n\n${agentContact}`;
        break;
      }

      case 'listing_agent_for_address': {
        const listing = findListingByAddressLike(userText);
        if (!listing) {
          reply =
            "I couldn't match that address to any listing in the CSV. Try copying the address as it appears in the list.";
          break;
        }
        lastListing = listing;
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const agentContact = formatAgentContact(row);
        reply = `${addr}\n\n${agentContact}`;
        break;
      }

      // ---------- LOAN TERMS ----------
      case 'loan_terms_for_index': {
        if (index == null) {
          reply = "I couldn't tell which listing number you meant.";
          break;
        }
        const { listing, error } = ensureListingForIndex(index);
        if (error) {
          reply = error;
          break;
        }
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const terms = formatLoanTerms(row);
        reply = `Loan terms for #${index} ${addr}:\n${terms}`;
        break;
      }

      case 'loan_terms_for_address': {
        const listing = findListingByAddressLike(userText);
        if (!listing) {
          reply =
            "I couldn't match that address to any listing in the CSV. Try copying the address as it appears in the list.";
          break;
        }
        lastListing = listing;
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const terms = formatLoanTerms(row);
        reply = `Loan terms for ${addr}:\n${terms}`;
        break;
      }

      // ---------- PROPERTY DESCRIPTION ----------
      case 'description_for_index': {
        if (index == null) {
          reply = "I couldn't tell which listing number you meant.";
          break;
        }
        const { listing, error } = ensureListingForIndex(index);
        if (error) {
          reply = error;
          break;
        }
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const description = formatDescription(row);
        reply = `Property description for #${index} ${addr}:\n${description}`;
        break;
      }

      case 'description_for_address': {
        const listing = findListingByAddressLike(userText);
        if (!listing) {
          reply =
            "I couldn't match that address to any listing in the CSV. Try copying the address as it appears in the list.";
          break;
        }
        lastListing = listing;
        const row = listing.row;
        const addr = listing.displayAddress || formatAddress(row);
        const description = formatDescription(row);
        reply = `Property description for ${addr}:\n${description}`;
        break;
      }

      // ---------- FOLLOW-UP ON LAST LISTING ----------
      case 'followup_about_last_listing': {
        if (!lastListing) {
          reply =
            "I'm not sure which property you mean by 'it'. Ask about a specific listing first (for example, 'details for #11').";
          break;
        }
        const row = lastListing.row;
        const addr = lastListing.displayAddress || formatAddress(row);
        const f = (fields || []).map((x) => String(x).toLowerCase());
        const parts = [`For ${addr}:`];

        if (!fields || !fields.length) {
          // default to a full summary if planner was vague
          const { text: bedsBathsText } = formatBedsBaths(row);
          parts.push(`Price: ${formatPrice(row)}`);
          parts.push(`Beds/Baths: ${bedsBathsText}`);
          parts.push(`Square footage: ${formatSqft(row)}`);
          parts.push(`Loan terms: ${formatLoanTerms(row)}`);
          parts.push(`Listing agent: ${formatAgent(row)}`);
          parts.push(`Property description:\n${formatDescription(row)}`);
          reply = parts.join('\n');
          break;
        }

        if (f.includes('price')) parts.push(`Price: ${formatPrice(row)}`);
        if (f.includes('beds') || f.includes('baths')) {
          const { text } = formatBedsBaths(row);
          parts.push(`Beds/Baths: ${text}`);
        }
        if (
          f.includes('description') ||
          f.includes('remarks') ||
          f.includes('property_description')
        ) {
          parts.push(`Property description:\n${formatDescription(row)}`);
        }
        if (f.includes('loan_terms') || f.includes('financing')) {
          parts.push(`Loan terms: ${formatLoanTerms(row)}`);
        }
        if (f.includes('address')) {
          parts.push(`Address: ${addr}`);
        }
        if (
          f.includes('square_footage') ||
          f.includes('sqft') ||
          f.includes('size')
        ) {
          parts.push(`Square footage: ${formatSqft(row)}`);
        }
        if (f.includes('agent')) {
          parts.push(`Listing agent: ${formatAgent(row)}`);
        }
        if (f.includes('contact_info') || f.includes('contact')) {
          parts.push(`Contact info:\n${formatAgentContact(row)}`);
        }
        if (f.includes('all_data') || f.includes('full_profile')) {
          parts.push('\nFull profile:\n' + formatFullRow(row));
        }

        reply = parts.join('\n');
        break;
      }

      // ---------- SMALL TALK / UNKNOWN ----------
      case 'small_talk': {
        reply =
          "Hey! I'm Realtor GPT. I’m wired up to your MLS CSV so you can ask things like:\n\n" +
          '• "show me all addresses in San Fernando with price next to them"\n' +
          '• "addresses under 900k with 3 beds in San Fernando"\n' +
          '• "what are the loan terms for #13"\n' +
          '• "what is the average price for houses in San Fernando?"\n' +
          '• "give me the full profile for #11"';
        break;
      }

      case 'unknown':
      default: {
        reply =
          "I'm not totally sure what you want yet. Try something like:\n" +
          '• "show me all addresses in San Fernando with price next to them"\n' +
          '• "show me addresses under 800k with 3 bedrooms in San Fernando"\n' +
          '• "who is the listing agent for #13"\n' +
          '• "how many beds and baths does 35 have?"\n' +
          '• "what is the property description for #11?"\n' +
          '• "what is the average price for houses in San Fernando?"\n' +
          '• "full profile for #11"';
      }
    }

    return res.json({ reply });
  } catch (err) {
    console.error('Server error while executing plan:', err);
    return res
      .status(500)
      .json({ error: 'Server error while answering your question.' });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

