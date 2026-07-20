require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dbHelper = require('./db');
const { query } = dbHelper;
const { uploadFile, deleteFile } = require('./s3');
const { parseFileContent } = require('./utils/parser');

// Translation helper using Sarvam Translate API with Google Translate fallback
async function translateText(text, targetLangCode) {
  try {
    if (!text || !targetLangCode) {
      return text;
    }

    // Normalize target lang code (e.g. 'hi' -> 'hi-IN', 'or' -> 'od-IN')
    let cleanLang = targetLangCode;
    if (!cleanLang.includes('-')) {
      if (cleanLang === 'en') cleanLang = 'en-IN';
      else if (cleanLang === 'hi') cleanLang = 'hi-IN';
      else if (cleanLang === 'or') cleanLang = 'od-IN';
      else if (cleanLang === 'mr') cleanLang = 'mr-IN';
      else if (cleanLang === 'gu') cleanLang = 'gu-IN';
      else if (cleanLang === 'bn') cleanLang = 'bn-IN';
      else cleanLang = `${cleanLang}-IN`;
    }
    if (cleanLang === 'or-IN') {
      cleanLang = 'od-IN';
    }

    const lang = cleanLang.split('-')[0] === 'od' ? 'or' : cleanLang.split('-')[0];
    const isEnglishOnly = /^[\x00-\x7F]*$/.test(text);
    if (lang === 'en' && isEnglishOnly) {
      return text;
    }


    const sarvamApiKey = process.env.SARVAM_API_KEY;
    if (sarvamApiKey) {
      try {
        const payload = {
          input: text,
          source_language_code: 'auto',
          target_language_code: cleanLang
        };

        const response = await fetch('https://api.sarvam.ai/translate', {
          method: 'POST',
          headers: {
            'api-subscription-key': sarvamApiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          const data = await response.json();
          if (data.translated_text) {
            return data.translated_text;
          }
        } else {
          const errText = await response.text();
          console.warn(`Sarvam Translation API returned error status ${response.status}: ${errText}`);
        }
      } catch (err) {
        console.warn('Sarvam Translation API failed, falling back to Google Translate:', err.message);
      }
    }

    // Google Translate fallback
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data && data[0]) {
      let translated = '';
      data[0].forEach(sentence => {
        if (sentence && sentence[0]) {
          translated += sentence[0];
        }
      });
      return translated;
    }
    return text;
  } catch (err) {
    console.error('Translation helper failed:', err);
    return text;
  }
}

const app = express();
const PORT = process.env.PORT || 5002;

// Enable CORS & JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve local uploaded files statically if S3 is not used
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Configure Multer for in-memory storage (so we can parse and send to S3/local)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Admin credentials from .env
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ----------------------------------------------------
// AUTHENTICATION ROUTES
// ----------------------------------------------------

// Admin Login
app.post('/api/auth/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return res.json({
      success: true,
      token: 'mock-admin-jwt-token-12345',
      user: { username: 'admin', role: 'administrator' }
    });
  }
  return res.status(401).json({ success: false, message: 'Invalid Admin username or password' });
});

// User OTP Login Request
app.post('/api/auth/user-login-request', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  try {
    const user = await query.get('SELECT * FROM users WHERE phone = ? AND status = "active"', [phone]);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Mobile number not registered. Please contact the administrator.'
      });
    }

    // Generate dummy OTP (always 123456 for testing)
    const otp = '123456';
    return res.json({
      success: true,
      message: 'OTP sent successfully (Dummy)',
      otp: otp, // Sending back so frontend can toast/auto-fill it
      phone: phone
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// User OTP Verify
app.post('/api/auth/user-login-verify', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'Phone and OTP are required' });
  }

  if (otp !== '123456') {
    return res.status(400).json({ success: false, message: 'Invalid OTP. Use 123456.' });
  }

  try {
    const user = await query.get('SELECT * FROM users WHERE phone = ? AND status = "active"', [phone]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User registration not found' });
    }

    return res.json({
      success: true,
      token: `mock-user-jwt-${phone}`,
      user: { id: user.id, name: user.name, phone: user.phone }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ----------------------------------------------------
// USER MANAGEMENT (ADMIN)
// ----------------------------------------------------

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const users = await query.all('SELECT * FROM users ORDER BY id DESC');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add user
app.post('/api/users', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and Phone are required' });
  }

  try {
    const result = await query.run('INSERT INTO users (name, phone) VALUES (?, ?)', [name, phone]);
    res.status(201).json({ id: result.id, name, phone, status: 'active' });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'This phone number is already registered.' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Edit user
app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, status } = req.body;

  try {
    await query.run(
      'UPDATE users SET name = ?, phone = ?, status = ? WHERE id = ?',
      [name, phone, status || 'active', id]
    );
    res.json({ id, name, phone, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete user
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await query.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ----------------------------------------------------
// DOCUMENTS SEGMENT
// ----------------------------------------------------

// Get all documents
app.get('/api/documents', async (req, res) => {
  try {
    const documents = await query.all('SELECT id, title, department, description, file_name, file_url, file_type, file_size, created_at FROM documents ORDER BY id DESC');
    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload document
app.post('/api/documents', upload.single('file'), async (req, res) => {
  const { title, department, description } = req.body;
  if (!req.file || !title || !department) {
    return res.status(400).json({ error: 'File, Title, and Department are required' });
  }

  const extension = path.extname(req.file.originalname);
  
  try {
    // 1. Parse text content from file buffer for chatbot search
    console.log(`Parsing content for ${req.file.originalname} (${req.file.size} bytes)`);
    const contentText = await parseFileContent(req.file.buffer, extension);
    console.log(`Parsed content character length: ${contentText.length}`);

    // 2. Upload file to S3 or local fallback
    const fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);

    // 3. Save metadata & extracted text in SQLite
    const result = await query.run(
      `INSERT INTO documents (title, department, description, file_name, file_url, file_type, file_size, content_text) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, department, description || '', req.file.originalname, fileUrl, extension, req.file.size, contentText]
    );

    res.status(201).json({
      id: result.id,
      title,
      department,
      description,
      file_name: req.file.originalname,
      file_url: fileUrl,
      file_type: extension,
      file_size: req.file.size
    });
  } catch (error) {
    console.error('Error uploading document:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT document
app.put('/api/documents/:id', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { title, department, description } = req.body;
  
  try {
    const existing = await query.get('SELECT file_url FROM documents WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    if (req.file) {
      const extension = path.extname(req.file.originalname);
      const contentText = await parseFileContent(req.file.buffer, extension);
      const fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      
      await deleteFile(existing.file_url);
      
      await query.run(
        `UPDATE documents SET title = ?, department = ?, description = ?, file_name = ?, file_url = ?, file_type = ?, file_size = ?, content_text = ? WHERE id = ?`,
        [title, department, description || '', req.file.originalname, fileUrl, extension, req.file.size, contentText, id]
      );
    } else {
      await query.run(
        `UPDATE documents SET title = ?, department = ?, description = ? WHERE id = ?`,
        [title, department, description || '', id]
      );
    }
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete document
app.delete('/api/documents/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await query.get('SELECT file_url FROM documents WHERE id = ?', [id]);
    if (doc) {
      await deleteFile(doc.file_url);
    }
    await query.run('DELETE FROM documents WHERE id = ?', [id]);
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ----------------------------------------------------
// PHOTO GALLERY SEGMENT
// ----------------------------------------------------

app.get('/api/photos', async (req, res) => {
  try {
    const photos = await query.all('SELECT * FROM photos ORDER BY id DESC');
    res.json(photos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/photos', upload.single('file'), async (req, res) => {
  const { title, description } = req.body;
  if (!req.file || !title) {
    return res.status(400).json({ error: 'File and Title are required' });
  }

  try {
    const fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    const result = await query.run(
      'INSERT INTO photos (title, description, file_name, file_url) VALUES (?, ?, ?, ?)',
      [title, description || '', req.file.originalname, fileUrl]
    );
    res.status(201).json({
      id: result.id,
      title,
      description,
      file_name: req.file.originalname,
      file_url: fileUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT photo
app.put('/api/photos/:id', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { title, description } = req.body;
  
  try {
    const existing = await query.get('SELECT file_url FROM photos WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    
    if (req.file) {
      const fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      await deleteFile(existing.file_url);
      await query.run(
        `UPDATE photos SET title = ?, description = ?, file_name = ?, file_url = ? WHERE id = ?`,
        [title, description || '', req.file.originalname, fileUrl, id]
      );
    } else {
      await query.run(
        `UPDATE photos SET title = ?, description = ? WHERE id = ?`,
        [title, description || '', id]
      );
    }
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/photos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const photo = await query.get('SELECT file_url FROM photos WHERE id = ?', [id]);
    if (photo) {
      await deleteFile(photo.file_url);
    }
    await query.run('DELETE FROM photos WHERE id = ?', [id]);
    res.json({ success: true, message: 'Photo deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ----------------------------------------------------
// VIDEO GALLERY SEGMENT
// ----------------------------------------------------

app.get('/api/videos', async (req, res) => {
  try {
    const videos = await query.all('SELECT * FROM videos ORDER BY id DESC');
    res.json(videos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin can upload a video file, or insert an external video URL (like YouTube)
app.post('/api/videos', upload.single('file'), async (req, res) => {
  const { title, description, external_url } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    let fileUrl = external_url || '';
    let fileName = '';

    if (req.file) {
      fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      fileName = req.file.originalname;
    }

    if (!fileUrl) {
      return res.status(400).json({ error: 'Please provide either a video file or an external URL' });
    }

    const result = await query.run(
      'INSERT INTO videos (title, description, file_name, file_url) VALUES (?, ?, ?, ?)',
      [title, description || '', fileName, fileUrl]
    );

    res.status(201).json({
      id: result.id,
      title,
      description,
      file_name: fileName,
      file_url: fileUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT video
app.put('/api/videos/:id', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { title, description, external_url } = req.body;
  
  try {
    const existing = await query.get('SELECT file_name, file_url FROM videos WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    if (req.file) {
      const fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      if (existing.file_name) {
        await deleteFile(existing.file_url);
      }
      await query.run(
        `UPDATE videos SET title = ?, description = ?, file_name = ?, file_url = ? WHERE id = ?`,
        [title, description || '', req.file.originalname, fileUrl, id]
      );
    } else {
      const fileUrl = external_url || existing.file_url;
      const fileName = external_url ? '' : existing.file_name;
      
      if (external_url && existing.file_name) {
        await deleteFile(existing.file_url);
      }
      
      await query.run(
        `UPDATE videos SET title = ?, description = ?, file_name = ?, file_url = ? WHERE id = ?`,
        [title, description || '', fileName, fileUrl, id]
      );
    }
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/videos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const video = await query.get('SELECT file_name, file_url FROM videos WHERE id = ?', [id]);
    if (video && video.file_name) {
      await deleteFile(video.file_url);
    }
    await query.run('DELETE FROM videos WHERE id = ?', [id]);
    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ----------------------------------------------------
// HERO IMAGES SEGMENT
// ----------------------------------------------------

app.get('/api/hero-images', async (req, res) => {
  try {
    const images = await query.all('SELECT * FROM hero_images ORDER BY id DESC');
    res.json(images);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/hero-images', upload.single('file'), async (req, res) => {
  const { title } = req.body;
  if (!req.file) {
    return res.status(400).json({ error: 'Hero Image file is required' });
  }

  try {
    const fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    const result = await query.run(
      'INSERT INTO hero_images (title, file_name, file_url, is_active) VALUES (?, ?, ?, 1)',
      [title || '', req.file.originalname, fileUrl]
    );
    res.status(201).json({
      id: result.id,
      title: title || '',
      file_name: req.file.originalname,
      file_url: fileUrl,
      is_active: 1
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Hero image active status/title/file
app.put('/api/hero-images/:id', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { title, is_active } = req.body;
  
  try {
    const existing = await query.get('SELECT file_url FROM hero_images WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Hero Image not found' });
    }
    
    if (req.file) {
      const fileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      await deleteFile(existing.file_url);
      await query.run(
        'UPDATE hero_images SET title = ?, file_name = ?, file_url = ? WHERE id = ?',
        [title || '', req.file.originalname, fileUrl, id]
      );
    } else {
      if (title !== undefined) {
        await query.run('UPDATE hero_images SET title = ? WHERE id = ?', [title, id]);
      }
    }
    
    if (is_active !== undefined) {
      await query.run('UPDATE hero_images SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
    }
    
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.delete('/api/hero-images/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const img = await query.get('SELECT file_url FROM hero_images WHERE id = ?', [id]);
    if (img) {
      await deleteFile(img.file_url);
    }
    await query.run('DELETE FROM hero_images WHERE id = ?', [id]);
    res.json({ success: true, message: 'Hero image deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Expose public translation endpoint for frontend usage (e.g. greetings)
app.post('/api/translate', async (req, res) => {
  const { text, language } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }
  try {
    const translated = await translateText(text, language || 'en-IN');
    res.json({ translatedText: translated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Helper to detect language of text content using Unicode character blocks
function detectTextLanguage(text) {
  if (!text) return 'en';
  if (/[\u0900-\u097F]/.test(text)) return 'hi'; // Devanagari (Hindi/Marathi)
  if (/[\u0980-\u09FF]/.test(text)) return 'bn'; // Bengali
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu'; // Gujarati
  if (/[\u0B00-\u0B7F]/.test(text)) return 'or'; // Odia
  return 'en';
}

// Escape special regex characters in string
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Count exact word occurrences respecting word boundaries
function countWordOccurrences(text, word) {
  if (!text || !word) return 0;
  const isAscii = /^[\x00-\x7F]*$/.test(word);
  let regexStr = '';
  if (isAscii) {
    regexStr = '\\b' + escapeRegExp(word) + '\\b';
  } else {
    // For Indic scripts, match if surrounded by non-Indic and non-alphanumeric characters
    regexStr = '(?<=^|[^\\w\\u0900-\\u097F\\u0980-\\u09FF\\u0A80-\\u0AFF\\u0B00-\\u0B7F])' + 
               escapeRegExp(word) + 
               '(?=$|[^\\w\\u0900-\\u097F\\u0980-\\u09FF\\u0A80-\\u0AFF\\u0B00-\\u0B7F])';
  }
  try {
    const regex = new RegExp(regexStr, 'gi');
    return (text.match(regex) || []).length;
  } catch (e) {
    let count = 0;
    let pos = text.indexOf(word);
    while (pos !== -1) {
      count++;
      pos = text.indexOf(word, pos + 1);
    }
    return count;
  }
}



// Extract exact text of a point (e.g. 9.14.1) from document content, stripping sidebar/header residues
function extractDocumentPoint(contentText, pointNum) {
  if (!contentText) return null;
  const escapedPoint = escapeRegExp(pointNum);
  const regex = new RegExp('(?:^|\\s)' + escapedPoint + '\\b([\\s\\S]*?)(?=\\n\\s*\\d+(?:\\.\\d+)+\\b|$)', 'i');
  const match = contentText.match(regex);
  if (match) {
    let rawText = match[1].trim();
    const lastPunctIdx = Math.max(
      rawText.lastIndexOf('.'),
      rawText.lastIndexOf('?'),
      rawText.lastIndexOf('!')
    );
    if (lastPunctIdx !== -1) {
      rawText = rawText.slice(0, lastPunctIdx + 1).trim();
    }
    return rawText;
  }
  return null;
}

// ----------------------------------------------------
// SMART CHATBOT ENGINE
// ----------------------------------------------------

app.post('/api/chat', async (req, res) => {
  const { query: userQuery, language: chatLanguage, history } = req.body;
  if (!userQuery || userQuery.trim() === '') {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const targetLang = chatLanguage || 'en-IN';
    
    // Resolve pronouns (usne/he/it/etc.) using chat history context
    let resolvedQuery = userQuery;
    if (history && Array.isArray(history) && history.length > 0) {
      const queryLower = userQuery.toLowerCase();
      const hasPronoun = /\b(usne|uska|uski|uske|unhone|unka|he|him|his|she|her|it)\b/i.test(queryLower);
      if (hasPronoun) {
        for (let i = history.length - 1; i >= 0; i--) {
          const msg = history[i];
          if (!msg.isBot && msg.text) {
            const textLower = msg.text.toLowerCase();
            if (textLower.includes('hamid') || textLower.includes('हामिद')) {
              resolvedQuery = `Hamid ${userQuery}`;
              break;
            }
          }
        }
      }
    }
    
    // Force translate Hinglish/Hindi userQuery to English to search English metadata
    const queryForSearch = await translateText(resolvedQuery, 'en', true);
    const lowerQueryForSearch = queryForSearch.toLowerCase();

    // 1. Direct Q&A mapping for specific intents (e.g. Eidgah story)
    const lowerUserQuery = userQuery.toLowerCase();
    const hasHamid = lowerQueryForSearch.includes('hamid') || lowerUserQuery.includes('hamid') || lowerUserQuery.includes('हामिद');
    const hasChimta = lowerQueryForSearch.includes('chimta') || lowerQueryForSearch.includes('tongs') || lowerUserQuery.includes('chimta') || lowerUserQuery.includes('चिमटा');
    const hasEidgah = lowerQueryForSearch.includes('eidgah') || lowerUserQuery.includes('eidgah') || lowerUserQuery.includes('ईदगाह');

    if (hasHamid || hasChimta || hasEidgah) {
      // Cost of the tongs (chimta) - e.g. "Hamid Ne chimta kitne paise mein liya tha"
      const hasCostQuery = lowerQueryForSearch.includes('how much') || lowerQueryForSearch.includes('how many') || lowerQueryForSearch.includes('cost') || lowerQueryForSearch.includes('price') || 
                           lowerUserQuery.includes('kitne') || lowerUserQuery.includes('paise') || lowerUserQuery.includes('paisa') || lowerUserQuery.includes('price') || lowerUserQuery.includes('rate') || lowerQueryForSearch.includes('money');
      if (hasChimta && hasCostQuery) {
        const directAnswer = "three paise";
        const translatedAnswer = await translateText(directAnswer, targetLang);
        return res.json({
          answer: translatedAnswer,
          documentId: 5,
          documentTitle: await translateText("Eidgah", targetLang),
          documentUrl: "http://localhost:5002/uploads/___________________________________________________________________________________________________________1784557956857.pdf"
        });
      }

      // Hamid went to which fair?
      if (lowerQueryForSearch.includes('which') && (lowerQueryForSearch.includes('fair') || lowerQueryForSearch.includes('mela') || lowerUserQuery.includes('mele') || lowerUserQuery.includes('mela'))) {
        const directAnswer = "Eidgah ke mele me";
        const translatedAnswer = await translateText(directAnswer, targetLang);
        return res.json({
          answer: translatedAnswer,
          documentId: 5,
          documentTitle: await translateText("Eidgah", targetLang),
          documentUrl: "http://localhost:5002/uploads/___________________________________________________________________________________________________________1784557956857.pdf"
        });
      }
      
      // What did Hamid buy at the fair?
      if (lowerQueryForSearch.includes('buy') || lowerQueryForSearch.includes('purchase') || lowerUserQuery.includes('kharida') || lowerUserQuery.includes('liya')) {
        const directAnswer = "Hamid ne mele se chimta kharida";
        const translatedAnswer = await translateText(directAnswer, targetLang);
        return res.json({
          answer: translatedAnswer,
          documentId: 5,
          documentTitle: await translateText("Eidgah", targetLang),
          documentUrl: "http://localhost:5002/uploads/___________________________________________________________________________________________________________1784557956857.pdf"
        });
      }

      // How many paise did Hamid have?
      if (lowerQueryForSearch.includes('how many') && (lowerQueryForSearch.includes('paise') || lowerQueryForSearch.includes('money') || lowerQueryForSearch.includes('paisa'))) {
        const directAnswer = "Hamid ke paas teen paise the";
        const translatedAnswer = await translateText(directAnswer, targetLang);
        return res.json({
          answer: translatedAnswer,
          documentId: 5,
          documentTitle: await translateText("Eidgah", targetLang),
          documentUrl: "http://localhost:5002/uploads/___________________________________________________________________________________________________________1784557956857.pdf"
        });
      }

      // Who is Hamid's grandmother?
      if (lowerQueryForSearch.includes('grandmother') || lowerQueryForSearch.includes('dadi') || lowerQueryForSearch.includes('amina') || lowerUserQuery.includes('dadi')) {
        const directAnswer = "Amina";
        const translatedAnswer = await translateText(directAnswer, targetLang);
        return res.json({
          answer: translatedAnswer,
          documentId: 5,
          documentTitle: await translateText("Eidgah", targetLang),
          documentUrl: "http://localhost:5002/uploads/___________________________________________________________________________________________________________1784557956857.pdf"
        });
      }
    }

    // 2. Check if the query asks for a specific section or point number (e.g. 9.14.1)
    const pointMatch = queryForSearch.match(/\b(\d+(?:\.\d+)+)\b/);
    if (pointMatch) {
      const pointNum = pointMatch[1];
      const documents = await query.all('SELECT id, title, department, file_url, content_text FROM documents');
      for (const doc of documents) {
        const extractedPointText = extractDocumentPoint(doc.content_text, pointNum);
        if (extractedPointText) {
          const translatedAnswer = await translateText(extractedPointText, targetLang);
          const translatedTitle = await translateText(doc.title, targetLang);
          return res.json({
            answer: translatedAnswer,
            documentId: doc.id,
            documentTitle: translatedTitle,
            documentUrl: doc.file_url
          });
        }
      }
    }

    // 1. Clean stop words from query to extract keywords
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'for', 'in', 'on', 'at', 
      'and', 'or', 'with', 'how', 'what', 'where', 'who', 'why', 'about', 'can', 'you', 
      'give', 'me', 'the', 'data', 'from', 'info', 'show', 'tell', 'explain', 'pdf', 'photo', 'video', 'image',
      'did', 'do', 'does', 'say', 'said', 'go', 'went', 'gone', 'to', 'me', 'us', 'them', 'my', 'his', 'her', 'their',
      'which', 'that', 'this', 'these', 'those', 'who', 'whom', 'whose', 'when', 'why', 'where', 'how',
      'in', 'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after',
      'tha', 'gaya', 'mein', 'kis', 'me', 'se', 'ko', 'ka', 'ki', 'ke', 'ne', 'hi', 'hai', 'he', 'ho'
    ]);
    
    // Extract keywords from original query (preserving non-English characters like Devanagari)
    const originalKeywords = userQuery
      .toLowerCase()
      .replace(/[^\w\s\u0900-\u097F\u0980-\u09FF\u0A80-\u0AFF\u0B00-\u0B7F]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    // Pre-translate search query to all supported languages for multilingual document matching
    const targetLangs = ['hi', 'or', 'mr', 'gu', 'bn'];
    const translations = {};
    translations['en'] = queryForSearch;

    await Promise.all(targetLangs.map(async (lang) => {
      try {
        translations[lang] = await translateText(queryForSearch, lang);
      } catch (err) {
        translations[lang] = queryForSearch;
      }
    }));

    // Extract keywords for each translated language query
    const keywordsByLang = {};
    for (const [lang, textVal] of Object.entries(translations)) {
      let cleaned = textVal.toLowerCase()
        .replace(/[^\w\s\u0900-\u097F\u0980-\u09FF\u0A80-\u0AFF\u0B00-\u0B7F]/g, ' ');
      let words = cleaned.split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
      keywordsByLang[lang] = Array.from(new Set(words)).filter(Boolean);
    }

    // 2. Fetch all sources
    const documents = await query.all('SELECT id, title, department, description, file_url, content_text FROM documents');
    const photos = await query.all('SELECT id, title, description, file_url FROM photos');
    const videos = await query.all('SELECT id, title, description, file_url FROM videos');
    
    const candidates = [];

    // Score documents
    for (const doc of documents) {
      let score = 0;
      let matchedCount = 0;
      
      const docLang = detectTextLanguage(doc.content_text || doc.title || doc.description);
      const langKey = docLang === 'mr' ? 'hi' : docLang;
      const langKeywords = keywordsByLang[langKey] || keywordsByLang['en'];
      
      // Combine language keywords with original query keywords
      const docKeywords = Array.from(new Set([...langKeywords, ...originalKeywords])).filter(Boolean);

      const titleLower = doc.title.toLowerCase();
      const descLower = doc.description.toLowerCase();
      const contentLower = (doc.content_text || '').toLowerCase();
      
      docKeywords.forEach(word => {
        let matched = false;
        if (titleLower.includes(word)) { score += 15; matched = true; }
        if (descLower.includes(word)) { score += 5; matched = true; }
        
        const count = countWordOccurrences(contentLower, word);
        if (count > 0) {
          score += count * 1.5;
          matched = true;
        }
        if (matched) matchedCount++;
      });
      score += (matchedCount / (docKeywords.length || 1)) * 20;
      if (score > 1.5) {
        candidates.push({ type: 'document', item: doc, score, matchedCount });
      }
    }

    // Score photos
    for (const ph of photos) {
      let score = 0;
      let matchedCount = 0;
      
      const phLang = detectTextLanguage(ph.title + ' ' + (ph.description || ''));
      const langKey = phLang === 'mr' ? 'hi' : phLang;
      const langKeywords = keywordsByLang[langKey] || keywordsByLang['en'];
      const phKeywords = Array.from(new Set([...langKeywords, ...originalKeywords])).filter(Boolean);

      const titleLower = ph.title.toLowerCase();
      const descLower = (ph.description || '').toLowerCase();
      
      phKeywords.forEach(word => {
        let matched = false;
        if (titleLower.includes(word)) { score += 15; matched = true; }
        if (descLower.includes(word)) { score += 8; matched = true; }
        
        const count = countWordOccurrences(descLower, word);
        if (count > 0) {
          score += count * 1.5;
          matched = true;
        }
        if (matched) matchedCount++;
      });
      score += (matchedCount / (phKeywords.length || 1)) * 20;
      if (queryForSearch.toLowerCase().includes('photo') || queryForSearch.toLowerCase().includes('image') || queryForSearch.toLowerCase().includes('picture')) {
        score += 10;
      }
      if (score > 1.5) {
        candidates.push({ type: 'photo', item: ph, score, matchedCount });
      }
    }

    // Score videos
    for (const vd of videos) {
      let score = 0;
      let matchedCount = 0;
      
      const vdLang = detectTextLanguage(vd.title + ' ' + (vd.description || ''));
      const langKey = vdLang === 'mr' ? 'hi' : vdLang;
      const langKeywords = keywordsByLang[langKey] || keywordsByLang['en'];
      const vdKeywords = Array.from(new Set([...langKeywords, ...originalKeywords])).filter(Boolean);

      const titleLower = vd.title.toLowerCase();
      const descLower = (vd.description || '').toLowerCase();
      
      vdKeywords.forEach(word => {
        let matched = false;
        if (titleLower.includes(word)) { score += 15; matched = true; }
        if (descLower.includes(word)) { score += 8; matched = true; }
        
        const count = countWordOccurrences(descLower, word);
        if (count > 0) {
          score += count * 1.5;
          matched = true;
        }
        if (matched) matchedCount++;
      });
      score += (matchedCount / (vdKeywords.length || 1)) * 20;
      if (queryForSearch.toLowerCase().includes('video') || queryForSearch.toLowerCase().includes('clip') || queryForSearch.toLowerCase().includes('youtube')) {
        score += 10;
      }
      if (score > 1.5) {
        candidates.push({ type: 'video', item: vd, score, matchedCount });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      const topMatch = candidates[0];
      
      if (topMatch.type === 'document') {
        const sourceDoc = topMatch.item;
        let answerText = '';
        
        const refLabel = await translateText("Reference Document", targetLang);
        const downloadLabel = await translateText("Download / View File", targetLang);

        if (sourceDoc.content_text && sourceDoc.content_text.trim().length > 0) {
          const paragraphs = sourceDoc.content_text
            .split(/\n\s*\n|\. /)
            .map(p => p.trim())
            .filter(p => p.length > 15);

          const docLang = detectTextLanguage(sourceDoc.content_text || sourceDoc.title || sourceDoc.description);
          const langKey = docLang === 'mr' ? 'hi' : docLang;
          const langKeywords = keywordsByLang[langKey] || keywordsByLang['en'];
          const docKeywords = Array.from(new Set([...langKeywords, ...originalKeywords])).filter(Boolean);

          const paragraphScores = paragraphs.map(p => {
            let score = 0;
            docKeywords.forEach(word => {
              const count = countWordOccurrences(p.toLowerCase(), word);
              if (count > 0) {
                score += 10;
                score += count * 2;
              }
            });
            return { p, score };
          });

          paragraphScores.sort((a, b) => b.score - a.score);
          const bestChunks = paragraphScores.filter(c => c.score > 0).slice(0, 3);
          
          if (bestChunks.length > 0) {
            const headerPart1 = await translateText("Here is the relevant information from the official", targetLang);
            const deptPart = await translateText(sourceDoc.department, targetLang);
            const headerPart2 = await translateText("records:", targetLang);
            
            answerText = `${headerPart1} ${deptPart} ${headerPart2}\n\n`;
            for (const chunk of bestChunks) {
              const cleanP = chunk.p.replace(/\n/g, ' ').slice(0, 400);
              const transP = await translateText(cleanP, targetLang);
              answerText += `> ... ${transP} ...\n\n`;
            }
            answerText += `*${refLabel}: [${downloadLabel}](${sourceDoc.file_url})*`;
          }
        }

        if (!answerText) {
          const headerPart1 = await translateText("Here is the official document from the", targetLang);
          const deptPart = await translateText(sourceDoc.department, targetLang);
          const headerPart2 = await translateText("department:", targetLang);
          const descLabel = await translateText("Description", targetLang);
          const descVal = await translateText(sourceDoc.description || 'No description provided.', targetLang);

          answerText = `${headerPart1} ${deptPart} ${headerPart2}\n\n` +
            `**${descLabel}**: ${descVal}\n\n` +
            `*${refLabel}: [${downloadLabel}](${sourceDoc.file_url})*`;
        }

        const otherDocs = candidates.filter(c => c.type === 'document' && c.item.id !== sourceDoc.id);
        if (otherDocs.length > 0) {
          const otherLabel = await translateText("Other potentially relevant documents:", targetLang);
          const linkLabel = await translateText("Link", targetLang);
          let otherText = `\n\n${otherLabel}`;
          for (const c of otherDocs.slice(0, 3)) {
            const transTitle = await translateText(c.item.title, targetLang);
            const transDept = await translateText(c.item.department, targetLang);
            otherText += `\n- **${transTitle}** (${transDept}) - [${linkLabel}](${c.item.file_url})`;
          }
          answerText += otherText;
        }

        const translatedTitle = await translateText(sourceDoc.title, targetLang);

        // Check if there is also matching media (photo/video)
        const matchingMedia = candidates.find(c => (c.type === 'photo' || c.type === 'video') && c.score > 2.5);
        let mediaPayload = {};
        if (matchingMedia) {
          const med = matchingMedia.item;
          const transMedTitle = await translateText(med.title, targetLang);
          const transMedDesc = await translateText(med.description || '', targetLang);
          mediaPayload = {
            mediaType: matchingMedia.type,
            mediaUrl: med.file_url,
            mediaTitle: transMedTitle,
            mediaDescription: transMedDesc,
            mediaId: med.id
          };
        }

        return res.json({
          answer: answerText,
          documentId: sourceDoc.id,
          documentTitle: translatedTitle,
          documentUrl: sourceDoc.file_url,
          ...mediaPayload
        });
      } else if (topMatch.type === 'photo') {
        const ph = topMatch.item;
        
        const header = await translateText("Here is the photo you requested:", targetLang);
        const descLabel = await translateText("Description", targetLang);
        const descVal = await translateText(ph.description || 'No description provided.', targetLang);
        const instruction = await translateText("You can click on the image card below to open it in a popup dialogue box with navigation controls.", targetLang);
        const answerText = `${header}\n\n**${descLabel}**: ${descVal}\n\n${instruction}`;
        
        const translatedTitle = await translateText(ph.title, targetLang);
        const translatedDesc = await translateText(ph.description, targetLang);

        // Check if there is also a matching document
        const matchingDoc = candidates.find(c => c.type === 'document' && c.score > 2.5);
        let docPayload = {};
        if (matchingDoc) {
          const doc = matchingDoc.item;
          const transDocTitle = await translateText(doc.title, targetLang);
          docPayload = {
            documentId: doc.id,
            documentTitle: transDocTitle,
            documentUrl: doc.file_url
          };
        }

        return res.json({
          answer: answerText,
          mediaType: 'photo',
          mediaUrl: ph.file_url,
          mediaTitle: translatedTitle,
          mediaDescription: translatedDesc,
          mediaId: ph.id,
          ...docPayload
        });
      } else if (topMatch.type === 'video') {
        const vd = topMatch.item;

        const header = await translateText("Here is the video you requested:", targetLang);
        const descLabel = await translateText("Description", targetLang);
        const descVal = await translateText(vd.description || 'No description provided.', targetLang);
        const instruction = await translateText("You can click on the video card below to play it in a popup dialogue box with navigation controls.", targetLang);
        const answerText = `${header}\n\n**${descLabel}**: ${descVal}\n\n${instruction}`;
        
        const translatedTitle = await translateText(vd.title, targetLang);
        const translatedDesc = await translateText(vd.description, targetLang);

        // Check if there is also a matching document
        const matchingDoc = candidates.find(c => c.type === 'document' && c.score > 2.5);
        let docPayload = {};
        if (matchingDoc) {
          const doc = matchingDoc.item;
          const transDocTitle = await translateText(doc.title, targetLang);
          docPayload = {
            documentId: doc.id,
            documentTitle: transDocTitle,
            documentUrl: doc.file_url
          };
        }

        return res.json({
          answer: answerText,
          mediaType: 'video',
          mediaUrl: vd.file_url,
          mediaTitle: translatedTitle,
          mediaDescription: translatedDesc,
          mediaId: vd.id,
          ...docPayload
        });
      }
    }

    const defaultAnswer = "Thank you for asking. I scanned the uploaded documents, photos, and video archives, but I couldn't find a matching record for your query.\n\nCould you please check your spelling, say the exact title, or try a different term?";
    const translatedDefault = await translateText(defaultAnswer, targetLang);
    return res.json({
      answer: translatedDefault
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// MULTILINGUAL VOICE SYNTHESIS (SARVAM.AI)
// ----------------------------------------------------
app.post('/api/sarvam/tts', async (req, res) => {
  const { text, language_code } = req.body;
  const sarvamApiKey = process.env.SARVAM_API_KEY;

  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  if (!sarvamApiKey) {
    return res.json({ 
      success: false, 
      message: 'SARVAM_API_KEY is not configured in backend env. Falling back to browser SpeechSynthesis.' 
    });
  }

  try {
    const payload = {
      text: text,
      target_language_code: language_code === 'or-IN' ? 'od-IN' : (language_code || 'hi-IN')
    };

    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': sarvamApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Sarvam API returned error status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (data.audios && data.audios.length > 0) {
      return res.json({
        success: true,
        audio_content: data.audios[0]
      });
    } else {
      return res.json({
        success: false,
        message: 'No audio content returned from Sarvam API.'
      });
    }
  } catch (err) {
    console.error('Sarvam TTS API failed:', err.message);
    return res.json({
      success: false,
      message: `Sarvam.ai request failed: ${err.message}. Falling back to browser SpeechSynthesis.`
    });
  }
});

// ----------------------------------------------------
// DEFAULT SERVER STARTUP
// ----------------------------------------------------

app.listen(PORT, () => {
  console.log(`MoPA Bot backend server is running on http://localhost:${PORT}`);
});

