const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let attendanceData = [];
let lastFetched = null;

// ── Helpers ────────────────────────────────────────────────────
function parseAttendance(raw) {
  const s = String(raw ?? '0').replace('%', '').trim();
  const val = parseFloat(s);
  if (isNaN(val)) return 0;
  return val > 100 ? parseFloat((val / 100).toFixed(1)) : val;
}

function parseMark(raw) {
  const val = parseFloat(String(raw ?? '0').trim());
  return isNaN(val) ? 0 : val;
}

function gradeFromMark(score) {
  if (score >= 90) return 'O';
  if (score >= 85) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 65) return 'B+';
  if (score >= 55) return 'B';
  if (score >= 45) return 'C';
  return 'F';
}

function statusLabel(att) {
  if (att >= 90) return 'excellent';
  if (att >= 75) return 'good';
  if (att >= 50) return 'average';
  return 'poor';
}

// ── POST /api/fetch-attendance ─────────────────────────────────
app.post('/api/fetch-attendance', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const tabName = encodeURIComponent(process.env.SHEET_TAB || 'Form_Responses');
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${tabName}`;

    const response = await axios.get(url);
    const jsonText = response.data.match(
      /google\.visualization\.Query\.setResponse\(([\s\S]*)\)/
    )[1];
    const json = JSON.parse(jsonText);

    // ── Exact column labels from your sheet ──
    const cols = json.table.cols.map(c => c.label);
console.log('📋 Detected columns:', JSON.stringify(cols));
const colMap = {};
cols.forEach((label, idx) => {
  colMap[label] = idx;
  colMap[label.toLowerCase().trim()] = idx;
  colMap[label.replace(/\s+/g, '').toLowerCase()] = idx;
});

    const rows = json.table.rows
  .filter(row => row.c && row.c.some(cell => cell && cell.v))
  .map(row => {
    const obj = {};
    row.c.forEach((cell, i) => {
      const label = cols[i];
      const val   = cell ? cell.v : '';
      obj[label]                                   = val;
      obj[label.toLowerCase().trim()]              = val;
      obj[label.replace(/\s+/g,'').toLowerCase()]  = val;
    });
    return obj;
  });
console.log('📄 Raw first row keys:', Object.keys(rows[0] || {}));
console.log('📄 Raw first row vals:', JSON.stringify(rows[0]));
    attendanceData = rows.map((row, i) => {
      // Try every possible variation of the column name
     const markRaw =
  row['Mark (out of 100)']    ??
  row['mark (out of 100)']    ??
  row['mark(outof100)']       ??
  row['Mark(outof100)']       ??
  row['Mark']                 ??
  row['mark']                 ??
  row['Marks']                ??
  row['Score']                ?? '';

const attRaw =
  row['Attendance(%)']        ??
  row['attendance(%)']        ??
  row['Attendance (%)']       ??
  row['attendance (%)']       ??
  row['Attendance']           ??
  row['attendance']           ?? '';

      const mark = parseMark(markRaw);
      const att  = parseAttendance(attRaw);

      const name   = row['Student Name'] || `Student ${i + 1}`;
      const id     = String(row['Student ID'] || '—');
      const course = row['Course/Department'] || row['Course'] || 'Unknown';

      console.log(`👤 ${name} | markRaw="${markRaw}" mark=${mark} | attRaw="${attRaw}" att=${att}`);

      return {
        name,
        id,
        course,
        mark,
        attendance: att,
        grade:      gradeFromMark(mark),
        pass:       mark >= 50 ? 'Pass' : 'Fail',
        status:     statusLabel(att),
        timestamp:  row['Timestamp'] || ''
      };
    });

    lastFetched = new Date().toLocaleTimeString();
    console.log(`\n🎯 Total loaded: ${attendanceData.length} students`);
    console.log('Sample:', JSON.stringify(attendanceData[0], null, 2));

    res.json({ success: true, count: attendanceData.length, lastFetched });
  } catch (err) {
    console.error('❌ Fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/debug ─────────────────────────────────────────────
app.get('/api/debug', (req, res) => {
  res.json({
    totalLoaded: attendanceData.length,
    firstRecord: attendanceData[0] || null,
    allRecords:  attendanceData
  });
});

// ── GET /api/analytics ─────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
  if (!attendanceData.length) return res.json({ error: 'No data loaded' });

  const total     = attendanceData.length;
  const excellent = attendanceData.filter(s => s.attendance >= 90).length;
  const good      = attendanceData.filter(s => s.attendance >= 75 && s.attendance < 90).length;
  const average   = attendanceData.filter(s => s.attendance >= 50 && s.attendance < 75).length;
  const poor      = attendanceData.filter(s => s.attendance < 50).length;

  const avgAttendance = (
    attendanceData.reduce((s, r) => s + r.attendance, 0) / total
  ).toFixed(1);

  const avgMark = (
    attendanceData.reduce((s, r) => s + r.mark, 0) / total
  ).toFixed(1);

  console.log(`📊 Analytics → avgMark=${avgMark} | avgAtt=${avgAttendance}`);

  // Course breakdown
  const courseMap = {};
  attendanceData.forEach(s => {
    if (!courseMap[s.course]) {
      courseMap[s.course] = { count: 0, totalAtt: 0, totalMark: 0 };
    }
    courseMap[s.course].count++;
    courseMap[s.course].totalAtt  += s.attendance;
    courseMap[s.course].totalMark += s.mark;
  });

  const courses = Object.entries(courseMap).map(([name, d]) => ({
    name,
    count:   d.count,
    avg:     (d.totalAtt  / d.count).toFixed(1),
    avgMark: (d.totalMark / d.count).toFixed(1)
  }));

  const students = attendanceData
    .map(s => ({
      name:   s.name,
      id:     s.id,
      course: s.course,
      att:    s.attendance,
      mark:   s.mark,
      grade:  s.grade,
      pass:   s.pass,
      status: s.status
    }))
    .sort((a, b) => b.att - a.att);

  res.json({
    total, excellent, good, average, poor,
    avgAttendance, avgMark, courses, students, lastFetched
  });
});

// ── POST /api/chat ─────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;

  if (!attendanceData.length) {
    return res.json({
      reply: '⚠️ No data loaded yet. Click **Sync Data** to load student records first.',
      type: 'warning'
    });
  }

  const total    = attendanceData.length;
  const avgAtt   = (attendanceData.reduce((s, r) => s + r.attendance, 0) / total).toFixed(1);
  const avgMark  = (attendanceData.reduce((s, r) => s + r.mark,       0) / total).toFixed(1);
  const atRisk   = attendanceData.filter(r => r.attendance < 75).length;
  const critical = attendanceData.filter(r => r.attendance < 50).length;

  const context = attendanceData.map(s =>
    `Name: ${s.name} | ID: ${s.id} | Course: ${s.course} | ` +
    `Mark: ${s.mark}/100 | Grade: ${s.grade} | ` +
    `Attendance: ${s.attendance}% | Result: ${s.pass}`
  ).join('\n');

  const systemPrompt = `You are an expert Student Performance Monitoring AI Agent for a college.

LIVE CLASS SUMMARY:
- Total Students: ${total}
- Average Mark: ${avgMark}/100
- Average Attendance: ${avgAtt}%
- At Risk (attendance < 75%): ${atRisk} students
- Critical (attendance < 50%): ${critical} students
- Last Synced: ${lastFetched}

FULL STUDENT RECORDS:
${context}

INSTRUCTIONS:
- Answer ONLY using the data above — never invent students
- Use **bold** for names and key numbers
- Flag attendance < 75% with ⚠️
- Flag attendance < 50% with 🚨
- Use ✅ for excellent attendance (≥ 90%)
- Give specific, actionable recommendations
- Keep responses clear and well-structured`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || []).slice(-10),
    { role: 'user', content: message }
  ];

  try {
    const response = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  1200,
      temperature: 0.4,
      messages
    });
    res.json({ reply: response.choices[0].message.content, type: 'success' });
  } catch (err) {
    console.error('❌ Groq error:', err.message);
    res.status(500).json({ reply: '❌ AI Error: ' + err.message, type: 'error' });
  }
});

// ── POST /api/report ───────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  if (!attendanceData.length) return res.json({ error: 'No data loaded' });

  const total   = attendanceData.length;
  const avgAtt  = (attendanceData.reduce((s, r) => s + r.attendance, 0) / total).toFixed(1);
  const avgMark = (attendanceData.reduce((s, r) => s + r.mark,       0) / total).toFixed(1);

  const context = attendanceData.map(s =>
    `${s.name} | ID: ${s.id} | Course: ${s.course} | Mark: ${s.mark}/100 | Grade: ${s.grade} | Attendance: ${s.attendance}% | ${s.pass}`
  ).join('\n');

  try {
    const response = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  2000,
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: `Generate a detailed student performance report for educators.

CLASS: ${total} students | Avg Mark: ${avgMark}/100 | Avg Attendance: ${avgAtt}%

STUDENT RECORDS:
${context}

Write a professional report with these exact sections:
**1. Executive Summary**
**2. Top Performers** (highest marks + attendance)
**3. ⚠️ At-Risk Students** (attendance < 75%)
**4. 🚨 Critical Cases** (attendance < 50%)
**5. Course-wise Analysis**
**6. Recommendations for Educators**

Use student names and IDs. Be specific with numbers and percentages.`
      }]
    });
    res.json({ report: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 EduPulse running → http://localhost:${PORT}`);
  console.log(`🔍 Debug URL → http://localhost:${PORT}/api/debug`);
});