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

// -------------------- IN-MEMORY STATE --------------------
let lastList = [];      // [{ rowIndex, displayAddress }]
let lastListing = null; // { rowIndex, displayAddress }

// -------------------- HELPERS --------------------
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

function normalizeAddressLike(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findListingByAddressLike(text) {
  if (!text) return null;
  const textNorm = normalizeAddressLike(text);
  let best = null;

  mlsRows.forEach((row, i) => {
    const addr = formatAddress(row);
    const addrNorm = normalizeAddressLike(addr);
    if (!addrNorm) return;

    if (textNorm.includes(addrNorm) || addrNorm.includes(textNorm)) {
      if (!best || addrNorm.length < best.addrNorm.length) {
        best = { rowIndex: i, row, addr, addrNorm };
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

function getColumnNameFromUserField(userField) {
  if (!userField) return null;
  const f = String(userField).trim();

  // if they already passed exact column name, use it directly if present
  if (mlsColumns.includes(f)) return f;

  const lower = f.toLowerCase();

  // common friendly names
  const synonyms = {
    address: null, // handled specially
    beds: 'BedroomsTotal',
    bedrooms: 'BedroomsTotal',
    baths: 'BathroomsTotalInteger',
    bathrooms: 'BathroomsTotalInteger',
    price: 'ListPrice',
    'current price': 'CurrentPrice',
    dom: 'DaysOnMarket',
    'days on market': 'DaysOnMarket',
    cdom: 'CumulativeDaysOnMarket',
    'cumulative days on market': 'CumulativeDaysOnMarket',
    zipcode: 'PostalCode',
    'zip code': 'PostalCode',
    'postal code': 'PostalCode',
    zip: 'PostalCode',
    sqft: 'LivingArea',
    'square footage': 'LivingArea',
    description: 'PublicRemarks',
    remarks: 'PublicRemarks',
    'loan terms': 'ListingTerms',
    financing: 'ListingTerms',
    'high school district': 'HighSchoolDistrict',
    'year built': 'YearBuilt',
  };

  if (synonyms[lower] !== undefined) {
    return synonyms[lower]; // may be null for "address"
  }

  // try case-insensitive match on actual columns
  const exactInsensitive = mlsColumns.find(
    (c) => c.toLowerCase() === lower
  );
  if (exactInsensitive) return exactInsensitive;

  // fuzzy: find column that contains this phrase
  const contains = mlsColumns.find((c) =>
    c.toLowerCase().includes(lower)
  );
  if (contains) return contains;

  return null;
}

function getValue(row, userField) {
  const colName = getColumnNameFromUserField(userField);

  if (colName === null) {
    // special "address"
    const lower = String(userField).toLowerCase();
    if (lower === 'address') {
      return formatAddress(row);
    }
    // fallback: try raw field as column
    if (row[userField] !== undefined) return row[userField];
    return '';
  }

  if (colName === 'ListPrice' || colName === 'CurrentPrice' || colName === 'ClosePrice') {
    const raw = row[colName];
    if (!raw) return '';
    const num = Number(raw);
    if (Number.isNaN(num)) return raw;
    return '$' + num.toLocaleString();
  }

  if (colName === 'BedroomsTotal' || colName === 'BathroomsTotalInteger' || colName === 'LivingArea') {
    const raw = row[colName];
    if (!raw) return '';
    const num = Number(raw);
    if (Number.isNaN(num)) return raw;
    if (colName === 'LivingArea') return num.toLocaleString() + ' sq ft';
    return String(num);
  }

  return row[colName] ?? '';
}

function applyFilter(row, filter) {
  const { column, op, value } = filter;
  const colName = getColumnNameFromUserField(column);
  if (!colName) return false;

  const raw = row[colName];
  const val = raw == null ? '' : String(raw);
  const numVal = Number(raw);
  const numTarget = Number(value);

  switch (op) {
    case 'eq':
      return val.toLowerCase() === String(value).toLowerCase();
    case 'neq':
      return val.toLowerCase() !== String(value).toLowerCase();
    case 'contains':
      return val.toLowerCase().includes(String(value).toLowerCase());
    case 'not_contains':
      return !val.toLowerCase().includes(String(value).toLowerCase());
    case 'gt':
      if (Number.isNaN(numVal) || Number.isNaN(numTarget)) return false;
      return numVal > numTarget;
    case 'ge':
      if (Number.isNaN(numVal) || Number.isNaN(numTarget)) return false;
      return numVal >= numTarget;
    case 'lt':
      if (Number.isNaN(numVal) || Number.isNaN(numTarget)) return false;
      return numVal < numTarget;
    case 'le':
      if (Number.isNaN(numVal) || Number.isNaN(numTarget)) return false;
      return numVal <= numTarget;
    case 'exists':
      return val.trim() !== '';
    case 'not_exists':
      return val.trim() === '';
    default:
      return true;
  }
}

function filterRows(filters) {
  if (!filters || !filters.length) return mlsRows;
  return mlsRows.filter((row) =>
    filters.every((f) => applyFilter(row, f))
  );
}

function ensureListingFromIndex(index) {
  if (!lastList.length) {
    return { error: 'I do not have a recent list to pull index numbers from.' };
  }
  const item = lastList[index - 1];
  if (!item) {
    return { error: `I do not have a listing #${index} in the last list.` };
  }
  const row = mlsRows[item.rowIndex];
  const displayAddress = item.displayAddress || formatAddress(row);
  lastListing = { rowIndex: item.rowIndex, displayAddress, row };
  return { row, displayAddress };
}

function formatDetails(row, fields) {
  const addr = formatAddress(row);
  if (!fields || !fields.length) {
    // default summary
    const summaryFields = [
      'Address',
      'ListPrice',
      'BedroomsTotal',
      'BathroomsTotalInteger',
      'LivingArea',
      'DaysOnMarket',
      'YearBuilt',
      'HighSchoolDistrict',
      'PropertyType',
      'PublicRemarks',
    ];

    const parts = [`${addr}`];
    summaryFields.forEach((f) => {
      const val = getValue(row, f);
      if (val === '' || val == null) return;
      const label = f === 'Address' ? 'Address' : f;
      parts.push(`${label}: ${val}`);
    });

    return parts.join('\n');
  }

  const lines = [`${addr}`];
  for (const f of fields) {
    const val = getValue(row, f);
    const label = String(f);
    lines.push(`${label}: ${val || 'N/A'}`);
  }

  return lines.join('\n');
}

function formatList(rows, fields, limit) {
  const limited = rows.slice(0, limit || 100);
  lastList = limited.map((row) => ({
    rowIndex: mlsRows.indexOf(row),
    displayAddress: formatAddress(row),
  }));

  if (!limited.length) {
    return 'There are 0 listings that match your criteria.';
  }

  const showFields = (fields || []).length ? fields : [];

  const lines = limited.map((row, i) => {
    const addr = formatAddress(row);
    if (!showFields.length) {
      return `#${i + 1} ${addr}`;
    }
    const parts = [];
    for (const f of showFields) {
      if (String(f).toLowerCase() === 'address') continue;
      const val = getValue(row, f);
      if (val === '' || val == null) continue;
      parts.push(`${f}: ${val}`);
    }
    const extra = parts.length ? ' — ' + parts.join(' | ') : '';
    return `#${i + 1} ${addr}${extra}`;
  });

  return `Here are up to ${limited.length} matching listings:\n` + lines.join('\n');
}

// -------------------- PLANNER PROMPT --------------------
const plannerSystemPrompt = `
You are the "planner" for Realtor GPT.

You ONLY return a single JSON object. The Node server will query the MLS CSV.

### CSV NOTES

The CSV header includes many MLS-style columns, for example:
- StreetNumber, StreetNumberNumeric, StreetDirPrefix, StreetName, StreetSuffix, City, StateOrProvince, PostalCode
- BedroomsTotal, BathroomsTotalInteger, LivingArea, ListPrice, CurrentPrice
- DaysOnMarket, CumulativeDaysOnMarket, OnMarketDate, OffMarketDate
- YearBuilt, HighSchoolDistrict, PropertyType, PoolFeatures, GarageSpaces, ParkingTotal, LotSizeArea, LotSizeSquareFeet, etc.
- PublicRemarks, PrivateRemarks, ListingTerms, HighSchoolDistrict

If the user mentions any REAL column name (e.g. "HighSchoolDistrict", "YearBuilt"), you must use it directly.

### FRIENDLY NAME → COLUMN

Map these friendly names:

- "beds", "bedrooms" -> "BedroomsTotal"
- "baths", "bathrooms" -> "BathroomsTotalInteger"
- "price" -> "ListPrice"
- "current price" -> "CurrentPrice"
- "DOM", "days on market" -> "DaysOnMarket"
- "CDOM", "cumulative days on market" -> "CumulativeDaysOnMarket"
- "zip", "zip code", "zipcode", "postal code" -> "PostalCode"
- "year built" -> "YearBuilt"
- "sqft", "square footage" -> "LivingArea"
- "description", "remarks" -> "PublicRemarks"
- "loan terms", "financing" -> "ListingTerms"
- "high school district" -> "HighSchoolDistrict"

### OUTPUT JSON

Return ONLY a JSON object with this structure:

{
  "intent": "list" | "details" | "small_talk" | "unknown",

  "filters": [
    {
      "column": string,                  // column name or friendly name
      "op": "eq" | "neq" | "gt" | "lt" | "ge" | "le" | "contains" | "not_contains" | "exists" | "not_exists",
      "value": string | number | null
    }
  ],

  "fields": string[] | null,            // which fields/columns they want in the output

  "targetType": "index" | "address" | "last" | null,
  "index": number | null,               // for "#34", "listing 34", etc.

  "limit": number | null,               // for lists: "top 10", "first 5"
  "countOnly": boolean | null           // if they only want the number of matches
}

### RULES

1. LIST queries:
   - The user is clearly asking for multiple properties.
   - Example phrases: "show me all ...", "list addresses ...", "give me a list ...", "how many listings ...".
   - Set intent = "list".
   - Use filters to describe conditions.

   Examples:

   - "show me addresses in San Fernando under 900k with 3 or more beds"
       -> intent: "list"
          filters: [
            { "column": "City", "op": "contains", "value": "San Fernando" },
            { "column": "ListPrice", "op": "le", "value": 900000 },
            { "column": "BedroomsTotal", "op": "ge", "value": 3 }
          ]
          fields: ["Address", "price", "beds", "baths"]

   - "give me list of addresses in zip code 91340"
       -> intent: "list"
          filters: [
            { "column": "PostalCode", "op": "eq", "value": "91340" }
          ]
          fields: ["Address"]

   - "show me all listings with a pool in Burbank"
       -> filters: [
            { "column": "City", "op": "contains", "value": "Burbank" },
            { "column": "PoolFeatures", "op": "exists", "value": null }
          ]
          fields: ["Address", "PoolFeatures"]

   - "how many listings are in zip 91340?"
       -> intent: "list"
          countOnly: true
          filters: [
            { "column": "PostalCode", "op": "eq", "value": "91340" }
          ]

2. DETAILS queries:
   - The user asks about a single property.
   - If they refer to "#12", "listing 12", just "12" etc -> targetType = "index", index = 12.
   - If they write a full street address (number + street name, plus maybe city/state/zip) -> targetType = "address".
   - If they say "it", "that one", "this property" referring to the previously discussed listing -> targetType = "last".

   Set intent = "details".

   Set fields to what they want:

   - "What is the high school district for 13121 Chase, Arleta, CA 91331?"
       -> intent: "details"
          targetType: "address"
          fields: ["HighSchoolDistrict"]

   - "How many days on market for 13121 Chase, Arleta, CA 91331?"
       -> intent: "details"
          targetType: "address"
          fields: ["DaysOnMarket"]

   - "What year was #34 built?"
       -> intent: "details"
          targetType: "index"
          index: 34
          fields: ["YearBuilt"]

   - "Give me the full profile for #11"
       -> intent: "details"
          targetType: "index"
          index: 11
          fields: null   // null or [] means "default summary with lots of key fields"

3. If the user message is *only* a number like "11" or "#11":
   - They want details for that listing.
   - intent = "details", targetType = "index", index = 11, fields = null.

4. "Address" is a virtual field; you may include "Address" in fields and the server will format it.

5. Greetings / chit-chat -> intent = "small_talk".

6. If you're unsure what they want -> intent = "unknown".

Return ONLY the JSON. No extra text.
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

  // quick greeting
  if (/^\s*(hi|hello|hey|hola)\s*$/i.test(userText)) {
    return res.json({
      reply:
        "Hey! I'm Realtor GPT. I can read your MLS CSV.\n\n" +
        'Try asking:\n' +
        '• "list addresses in zip 91340 with price and beds"\n' +
        '• "show me all listings in San Fernando under 900k with 3+ beds"\n' +
        '• "what is the high school district for 13121 Chase, Arleta, CA 91331"\n' +
        '• "how many days on market for #5"\n' +
        '• "full profile for #11"',
    });
  }

  // ---- call OpenAI planner ----
  let plan;
  try {
    const plannerMessages = [
      { role: 'system', content: plannerSystemPrompt },
      ...history,
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('OpenAI planner error:', data);
      return res
        .status(500)
        .json({ error: data.error?.message || 'OpenAI API error' });
    }

    const content = data.choices?.[0]?.message?.content || '{}';
    plan = JSON.parse(content);
    console.log('📝 Planner plan:', JSON.stringify(plan, null, 2));
  } catch (err) {
    console.error('Failed to get/parse planner output:', err);
    return res.status(500).json({ error: 'Failed to interpret query.' });
  }

  const intent = plan.intent || 'unknown';
  const filters = Array.isArray(plan.filters) ? plan.filters : [];
  const fields = Array.isArray(plan.fields) ? plan.fields : null;
  const targetType = plan.targetType || null;
  const index = plan.index ?? null;
  const limit = plan.limit ?? null;
  const countOnly = !!plan.countOnly;

  let reply = '';

  try {
    if (intent === 'list') {
      const rows = filterRows(filters);

      if (countOnly) {
        reply = `There are ${rows.length} listings that match your criteria.`;
      } else {
        reply = formatList(rows, fields, limit || 100);
      }
    } else if (intent === 'details') {
      let row;
      let addr;

      if (targetType === 'index' && index != null) {
        const resIdx = ensureListingFromIndex(index);
        if (resIdx.error) {
          reply = resIdx.error;
        } else {
          row = resIdx.row;
          addr = resIdx.displayAddress;
        }
      } else if (targetType === 'address') {
        const listing = findListingByAddressLike(userText);
        if (!listing) {
          reply =
            "I couldn't match that address to any listing in the CSV. Try copying it as it appears in the list.";
        } else {
          lastListing = listing;
          row = listing.row;
          addr = listing.displayAddress;
        }
      } else if (targetType === 'last') {
        if (!lastListing) {
          reply =
            "I'm not sure which property you mean. Ask about a specific listing first (for example, 'details for #11').";
        } else {
          row = lastListing.row;
          addr = lastListing.displayAddress;
        }
      } else {
        reply =
          "I couldn't tell which specific listing you meant. Try '#11' or a full address like '123 Main St, Burbank, CA'.";
      }

      if (row) {
        reply = formatDetails(row, fields);
      }
    } else if (intent === 'small_talk') {
      reply =
        "Hey! I'm Realtor GPT. I’m wired up to your MLS CSV so you can ask things like:\n\n" +
        '• "list addresses in zip 91340 with price and beds"\n' +
        '• "show me all listings in San Fernando under 900k with 3+ beds"\n' +
        '• "what is the high school district for 13121 Chase, Arleta, CA 91331"\n' +
        '• "days on market for #5"\n' +
        '• "full profile for #11"';
    } else {
      reply =
        "I'm not totally sure what you want yet. Try something like:\n" +
        '• "list addresses in zip 91340 with price next to them"\n' +
        '• "show me listings under 900k with 3 beds in San Fernando"\n' +
        '• "what is the high school district for 13121 Chase, Arleta, CA 91331"\n' +
        '• "how many days on market does #5 have?"\n' +
        '• "full profile for #11"';
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
