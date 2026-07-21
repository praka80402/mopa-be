const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

// Ensure local uploads directory exists for fallback
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// S3 Configuration
const s3Bucket = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME;
const isS3Configured = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  s3Bucket &&
  process.env.AWS_REGION
);

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.SERVER_URL || '').replace(/\/$/, '');
}

function buildPublicUrl(routePath) {
  const baseUrl = getPublicBaseUrl();
  return baseUrl ? `${baseUrl}${routePath}` : routePath;
}

let s3Client = null;
if (isS3Configured) {
  try {
    s3Client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    console.log('AWS S3 Client initialized.');
  } catch (error) {
    console.error('Failed to initialize AWS S3 Client:', error.message);
  }
} else {
  console.log('AWS S3 is NOT configured in .env. Falling back to local storage.');
}


/**
 * Uploads a file buffer. Uses S3 if configured, else saves to local public/uploads directory.
 * @param {Buffer} fileBuffer 
 * @param {string} originalName 
 * @param {string} mimeType 
 * @returns {Promise<string>} The URL of the uploaded file
 */
async function uploadFile(fileBuffer, originalName, mimeType) {
  const timestamp = Date.now();
  const fileExt = path.extname(originalName);
  const cleanBase = path.basename(originalName, fileExt).replace(/[^a-zA-Z0-9]/g, '_');
  const uniqueName = `${cleanBase}_${timestamp}${fileExt}`;

  if (isS3Configured && s3Client) {
    try {
      const command = new PutObjectCommand({
        Bucket: s3Bucket,
        Key: uniqueName,
        Body: fileBuffer,
        ContentType: mimeType,
        ACL: 'public-read' // Note: bucket policies may need to allow this
      });
      await s3Client.send(command);
      
      const s3Url = `https://${s3Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${uniqueName}`;
      console.log(`Successfully uploaded ${originalName} to S3: ${s3Url}`);
      return s3Url;
    } catch (error) {
      console.error(`S3 upload failed for ${originalName}, saving locally:`, error.message);
      // Fall through to local fallback
    }
  }

  // Local fallback
  const localPath = path.join(uploadDir, uniqueName);
  fs.writeFileSync(localPath, fileBuffer);
  const localUrl = buildPublicUrl(`/uploads/${uniqueName}`);
  console.log(`Saved ${originalName} locally: ${localUrl}`);
  return localUrl;
}

/**
 * Deletes a file. Removes from S3 if it was stored there, or deletes local file.
 * @param {string} fileUrl 
 */
async function deleteFile(fileUrl) {
  if (!fileUrl) return;

  // Check if it's an S3 URL
  if (fileUrl.includes('amazonaws.com')) {
    if (isS3Configured && s3Client) {
      try {
        const urlParts = fileUrl.split('/');
        const key = urlParts[urlParts.length - 1];
        const command = new DeleteObjectCommand({
          Bucket: s3Bucket,
          Key: key
        });
        await s3Client.send(command);
        console.log(`Deleted S3 object: ${key}`);
      } catch (error) {
        console.error(`Failed to delete S3 file: ${fileUrl}`, error.message);
      }
    }
  } else {
    // Local file deletion
    try {
      const urlParts = fileUrl.split('/uploads/');
      if (urlParts.length > 1) {
        const localFileName = urlParts[1];
        const localPath = path.join(uploadDir, localFileName);
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          console.log(`Deleted local file: ${localFileName}`);
        }
      }
    } catch (error) {
      console.error(`Failed to delete local file: ${fileUrl}`, error.message);
    }
  }
}

module.exports = {
  uploadFile,
  deleteFile,
  buildPublicUrl
};
