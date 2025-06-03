import xlsx from 'xlsx';

try {
    // Read input Excel file
    const inputFile = 'input_urls.xlsx';
    const workbook = xlsx.readFile(inputFile);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const data = xlsx.utils.sheet_to_json(worksheet);
    
    console.log('Excel file contents:');
    console.log('Sheet name:', sheetName);
    console.log('Number of rows:', data.length);
    console.log('\nColumn names:', Object.keys(data[0] || {}));
    console.log('\nFirst few rows:');
    console.log(data.slice(0, 3));
} catch (error) {
    console.error('Error reading Excel file:', error.message);
} 