/**
 * Deploy this as a Web App:
 *   Extensions > Apps Script (from a Sheet, or script.google.com for a standalone project)
 *   Deploy > New deployment > Web app
 *     Execute as: Me
 *     Who has access: Anyone
 *   Copy the resulting /exec URL into SCRIPT_URL in docs/index.html
 *
 * Fill in FOLDER_ID below with the Drive folder you want results saved into.
 * (Optional) Fill in SHEET_ID + SHEET_NAME to also log an index row per submission.
 */

const FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID_HERE';

// Optional: leave SHEET_ID empty ('') to skip Sheet logging entirely.
const SHEET_ID = '';
const SHEET_NAME = 'Submissions';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (!data.htmlContent || !data.candidateName) {
      return jsonOut({ status: 'error', message: 'Missing candidateName or htmlContent' });
    }

    const folder = DriveApp.getFolderById(FOLDER_ID);
    const fileName = data.fileName || (safeSlug(data.candidateName) + '_' + Date.now() + '.html');

    const file = folder.createFile(fileName, data.htmlContent, MimeType.HTML);
    const fileUrl = file.getUrl();

    if (SHEET_ID) {
      const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME)
        || SpreadsheetApp.openById(SHEET_ID).insertSheet(SHEET_NAME);
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(['Timestamp', 'Candidate Name', 'Candidate Email', 'File Name', 'Drive Link']);
      }
      sheet.appendRow([new Date(), data.candidateName, data.candidateEmail || '', fileName, fileUrl]);
    }

    return jsonOut({ status: 'success', fileUrl: fileUrl, fileId: file.getId() });
  } catch (err) {
    return jsonOut({ status: 'error', message: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'candidate';
}
