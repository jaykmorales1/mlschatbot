// server.js
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Load MLS Spreadsheet ----
let mlsDataText = '';

try {
  // 👇 make sure this file name matches EXACTLY (include .csv if needed)
  const csv = fs.readFileSync('./data/Active Listings.csv', 'utf8'); // or './data/mls.csv'
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    comment: '#',            // ignore lines that start with #
    relax_column_count: true // don't crash if some rows have extra/missing columns
  });

  const lines = records.map((row, idx) => `Row ${idx + 1}: ${JSON.stringify(row)}`);
  mlsDataText = lines.join('\n');

  // prevent overloading the AI context
  mlsDataText = mlsDataText.slice(0, 12000);

  console.log('Loaded MLS file with', records.length, 'rows');
} catch (err) {
  console.error('Could not load MLS file:', err.message);
}

// -------- Middleware --------
app.use(express.json());
app.use(express.static('public'));

// -------- Chat endpoint --------
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is missing in .env' });
  }

  try {
    const history = messages || [];

    const openaiMessages = [
      {
        role: 'system',
        content:
          "You are Realtor GPT. You have access to MLS data. " +
          "Use the MLS spreadsheet below to answer questions accurately. " +
          "If something is not in the data, say so instead of making it up.\n\n" +
          mlsDataText,
      },
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
        messages: openaiMessages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenAI API Error:', data);
      return res
        .status(500)
        .json({ error: data.error?.message || 'OpenAI API error' });
    }

    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ reply });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error talking to OpenAI' });
  }
});

// -------- Start server --------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

