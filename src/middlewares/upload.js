const multer = require('multer');

// Use Memory Storage for all file uploads since we use Cloudinary and fast memory parsing
const storage = multer.memoryStorage();

// File filter
const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    'application/pdf': true,
    'text/csv': true,
    'application/vnd.ms-excel': true,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true,
    'application/msword': true,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
  };

  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed. Accepted: PDF, CSV, Excel, Word.`), false);
  }
};

const maxSize = (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024;

// Export configured multer instances (in-memory)
const uploadResume = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxSize },
}).single('resume');

const uploadSpreadsheet = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxSize },
}).single('spreadsheet');

const uploadMultipleResumes = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxSize },
}).array('resumes', 50);

module.exports = { uploadResume, uploadSpreadsheet, uploadMultipleResumes };
