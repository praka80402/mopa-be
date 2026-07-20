const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');

/**
 * Extracts text content from a file buffer based on its extension.
 * @param {Buffer} fileBuffer 
 * @param {string} extension (e.g. '.pdf', '.docx', '.xlsx')
 * @returns {Promise<string>} The parsed text content
 */
async function parseFileContent(fileBuffer, extension) {
  const ext = extension.toLowerCase();
  
  try {
    if (ext === '.pdf') {
      const data = await pdfParse(fileBuffer);
      return (data.text || '').replace(/\u0000/g, '');
    }
    
    if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return (result.value || '').replace(/\u0000/g, '');
    }
    
    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
      let text = '';
      workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        // Convert sheet to text
        const sheetText = xlsx.utils.sheet_to_txt(sheet);
        if (sheetText) {
          text += `[Sheet: ${sheetName}]\n${sheetText}\n\n`;
        }
      });
      return text.replace(/\u0000/g, '');
    }
    
    // For images, ppt, or other file formats, we return empty string.
    // The chatbot will search their title and description instead.
    return '';
  } catch (error) {
    console.error(`Error parsing file with extension ${extension}:`, error.message);
    return '';
  }
}

module.exports = {
  parseFileContent
};
