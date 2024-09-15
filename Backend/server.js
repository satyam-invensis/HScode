import express from 'express';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import cors from 'cors';
import { stringToHash, verifyHash } from 'bcrypt-inzi';

// Initialize Express app
const app = express();
const __dirname = path.resolve();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Set view engine and static files
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../Frontend'));
app.use(express.static(path.join(__dirname, '../Frontend')));

// CSV Data Handling
let csvData = [];
const csvFilePath = path.join(__dirname, 'htsdata.csv');

function loadCSV(callback) {
    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (data) => {
            let score = extractNumericScore(data['Column 2 Rate of Duty']);
            data.Score = score;
            csvData.push(data);
        })
        .on('end', () => {
            console.log('CSV data loaded successfully');
            callback(null);
        })
        .on('error', (err) => {
            console.error('Error reading CSV file:', err);
            callback(err);
        });
}

loadCSV((err) => {
    if (err) {
        console.error('Failed to load CSV data. Exiting...');
        process.exit(1);
    }
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
});

// Routes for CSV Data Processing
app.get('/', (req, res) => {
    res.render('index');  // Render the homepage with the form
});

app.post('/predict', (req, res) => {
    try {
        const inputText = req.body.text ? req.body.text.trim().toLowerCase() : '';

        if (!inputText) {
            throw new Error('Input text is empty');
        }

        let predictions = predictFromCSV(inputText);

        if (predictions.length > 0) {
            predictions.forEach(p => {
                p.score = (p.score).toFixed(2) + '%'; // Ensure score is formatted as a percentage
                p.htsNumber = formatHSCode(p.htsNumber);
            });
            res.render('result', { results: predictions, error: null, userInput: inputText });
        } else {
            res.render('result', { results: [], error: 'No matching results found.', userInput: inputText });
        }
    } catch (error) {
        console.error('Error during prediction:', error);
        res.status(500).render('result', { results: [], error: 'An error occurred. Please try again.', userInput: inputText });
    }
});



// Routes for Authentication
const dbURI = 'mongodb+srv://satyam149sharma:satyam2000@hscodes.78y8n.mongodb.net/HS_Codes?retryWrites=true&w=majority';

mongoose.connect(dbURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Mongoose is connected'))
    .catch(err => {
        console.error('Mongoose connection error:', err);
        process.exit(1);
    });

mongoose.connection.on('disconnected', () => {
    console.log('Mongoose is disconnected');
});

mongoose.connection.on('error', err => {
    console.error('Mongoose connection error:', err);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('App is terminating');
    mongoose.connection.close(() => {
        console.log('Mongoose default connection closed');
        process.exit(0);
    });
});

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    createdOn: { type: Date, default: Date.now },
});

const userModel = mongoose.model('User', userSchema);

app.post('/signup', async (req, res) => {
    const { firstName, lastName, email, password } = req.body;

    if (!firstName || !lastName || !email || !password) {
        return res.status(400).send({
            message: 'Required fields missing',
            example: {
                firstName: 'John',
                lastName: 'Doe',
                email: 'abc@abc.com',
                password: '12345'
            }
        });
    }

    try {
        const existingUser = await userModel.findOne({ email }).exec();

        if (existingUser) {
            return res.status(400).send({ message: 'User already exists. Please try a different email.' });
        }

        const hashedPassword = await stringToHash(password);
        const newUser = new userModel({
            firstName,
            lastName,
            email: email.toLowerCase(),
            password: hashedPassword
        });

        await newUser.save();
        res.status(201).send({ message: 'User created successfully.' });
    } catch (error) {
        res.status(500).send({ message: 'Internal server error.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).send({
            message: 'Required fields missing',
            example: {
                email: 'abc@abc.com',
                password: '12345'
            }
        });
    }

    try {
        const user = await userModel.findOne({ email }).exec();

        if (!user) {
            return res.status(404).send({ message: 'User not found.' });
        }

        const isPasswordValid = await verifyHash(password, user.password);

        if (!isPasswordValid) {
            return res.status(401).send({ message: 'Incorrect password.' });
        }

        res.status(200).json({
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            message: 'Login successful.',
            redirectUrl: 'http://localhost:5500/Frontend/index.html' 
        });
    } catch (error) {
        res.status(500).send({ message: 'Internal server error.' });
    }
});

// Utility functions
function predictFromCSV(text) {
    return csvData
        .filter(row => row.Description && row.Description.toLowerCase().includes(text))
        .map(row => ({
            htsNumber: row['﻿HTS Number'] || 'N/A',
            description: row.Description || 'N/A',
            score: row.Score || 0,
            tarif: formatTarif(row['General Rate of Duty']) || 'N/A',
            measurementUnit: formatMeasurementUnit(row['Unit of Quantity']) || 'N/A'
        }))
        .sort((a, b) => b.score - a.score) // Sort by score descending
        .slice(0, 8); // Get the top 8 entries
}

function extractNumericScore(dutyRate) {
    if (!dutyRate) return 0;

    let match = dutyRate.match(/(\d+(\.\d+)?)%?/);
    if (match) {
        return parseFloat(match[1]);
    }
    return 0;
}

function formatHSCode(code) {
    if (code === 'N/A' || !code.trim()) return code;
    let cleanedCode = code.replace(/[^\d.]/g, '');
    let parts = cleanedCode.split('.');
    if (parts.length === 1) {
        if (cleanedCode.length <= 4) {
            return cleanedCode; 
        }
        return cleanedCode.replace(/(\d{4})(\d{2})$/, '$1.$2');
    }
    if (parts.length === 2) {
        return cleanedCode.replace(/(\d{4})\.(\d{2})$/, '$1.$2');
    }
    if (parts.length === 3) {
        return cleanedCode.replace(/(\d{4})\.(\d{2})\.(\d{2})$/, '$1.$2.$3');
    }
    if (parts.length === 4) {
        return cleanedCode.replace(/(\d{4})\.(\d{2})\.(\d{2})\.(\d{2})$/, '$1.$2.$3.$4');
    }
    return code;
}

function formatTarif(tarif) {
    if (!tarif) return 'N/A';
    if (tarif.startsWith('Free')) {
        return 'Free';
    }
    let match = tarif.match(/(\d+(\.\d+)?%?)/);
    if (match) {
        return match[1];
    }
    return tarif;
}

function formatMeasurementUnit(unit) {
    if (!unit) return 'N/A';
    try {
        let unitsArray = JSON.parse(unit);
        if (Array.isArray(unitsArray) && unitsArray.includes('kg')) {
            return 'Kg';
        }
        if (Array.isArray(unitsArray) && unitsArray.includes('lt')) {
            return 'Lt';
        }
    } catch (e) {
        return unit;
    }
    return unit;
}
