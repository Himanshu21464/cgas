const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const { parse, stringify } = require('csv');
const { Readable } = require('stream');
const uuid = require('uuid');  // Use UUID for unique recipe IDs
const bcrypt = require('bcrypt');


dotenv.config();
const app = express();


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const BUCKET_NAME = 'cgas-recipe-data';

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.get('/', (req, res) => {
    res.send('Welcome to the Recipe Upload API');
});

const fileExists = async (key) => {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
        return true;
    } catch (error) {
        if (error.name === 'NotFound') return false;
        throw error;
    }
};

const readFileFromS3 = async (key) => {
    const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const stream = data.Body;
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
};

const writeFileToS3 = async (key, content) => {
    await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: content,
            ContentType: 'text/csv',
        })
    );
};


// -------------------------------------------USER-----------------------------

// Registration endpoint
app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    const userData = {
        username,
        email,
        password, // Note: The password will be hashed below
        createdAt: new Date().toISOString(),
    };

    const fileKey = 'users/user.csv';

    try {
        // Validate username and email
        if (!username || !email || !password) {
            return res.status(400).json({ message: 'Username, email, and password are required' });
        }

        // Hash the password before saving it
        const hashedPassword = await bcrypt.hash(password, 10);
        userData.password = hashedPassword;

        // Check if the user.csv file exists in S3
        if (await fileExists(fileKey)) {
            // If it exists, read the file
            const existingContent = await readFileFromS3(fileKey);

            // Parse the CSV content 
            const existingUsers = await new Promise((resolve, reject) => {
                parse(existingContent, { columns: true }, (err, output) => {
                    if (err) return reject(err);
                    resolve(output);
                });
            });

            // Check for existing username or email
            const usernameExists = existingUsers.some(user => user.username === username);
            const emailExists = existingUsers.some(user => user.email === email);

            if (usernameExists) {
                return res.status(400).json({ message: 'Username already exists' });
            }

            if (emailExists) {
                return res.status(400).json({ message: 'Email already registered' });
            }

            // Append the new user to the existing users
            existingUsers.push(userData);

            // Convert the updated data back to CSV
            const csvContent = await new Promise((resolve, reject) => {
                stringify(existingUsers, { header: true }, (err, output) => {
                    if (err) return reject(err);
                    resolve(output);
                });
            });

            // Write the updated CSV back to S3
            await writeFileToS3(fileKey, csvContent);
            return res.status(200).json({ message: 'User registered successfully', user: { username, email } });
        } else {
            // If the file doesn't exist, create it with the header and first user
            const csvContent = await new Promise((resolve, reject) => {
                stringify([userData], { header: true }, (err, output) => {
                    if (err) return reject(err);
                    resolve(output);
                });
            });

            // Create the new CSV file in S3
            await writeFileToS3(fileKey, csvContent);
            return res.status(200).json({ message: 'User registered successfully', user: { username, email } });
        }
    } catch (error) {
        console.error('Error during registration:', error);
        res.status(500).json({ message: 'Error registering user', error: error.message });
    }
});

// Login endpoint
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const fileKey = 'users/user.csv';

    try {
        if (!await fileExists(fileKey)) {
            return res.status(404).json({ message: 'No users found' });
        }

        const existingContent = await readFileFromS3(fileKey);
        const users = await new Promise((resolve, reject) => {
            parse(existingContent, { columns: true }, (err, output) => {
                if (err) return reject(err);
                resolve(output);
            });
        });

        const user = users.find(u => u.username === username);
        if (!user) {
            return res.status(400).json({ message: 'User not found' });
        }

        // Compare hashed password
        const isPasswordCorrect = await bcrypt.compare(password, user.password);
        if (!isPasswordCorrect) {
            return res.status(400).json({ message: 'Incorrect password' });
        }

        // Send user data as response
        res.status(200).json({
            message: 'Login successful',
            user: {
                username: user.username,
                email: user.email,
            },
        });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ message: 'Error during login', error: error.message });
    }
});
// --------------------------------------------------------------------------------------------------


app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        // Logging received body and file
        console.log('Request Body:', req.body);
        console.log('Uploaded File:', req.file);
        
        const {
            name,
            ingredients,
            steps,
            username,
            duration,
            servings,
            dietaryPreferences,
            calories,
            fat,
            likeCount,
            dislikeCount,
            carbohydrates,
            protein,
            finalIngredientList,
        } = req.body;

        // Validate required fields
        if (
            !name ||
            !ingredients ||
            !steps ||
            !duration ||
            !servings ||
            !dietaryPreferences ||
            !calories ||
            !fat ||
            !carbohydrates ||
            !protein ||
            !finalIngredientList
        ) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        // Parse ingredients
        let parsedIngredients;
        try {
            parsedIngredients = JSON.parse(ingredients);
        } catch (error) {
            return res.status(400).json({ message: 'Ingredients must be valid JSON.' });
        }

        // Validate numeric fields
        if (
            isNaN(duration) ||
            isNaN(servings) ||
            isNaN(calories) ||
            isNaN(fat) ||
            isNaN(carbohydrates) ||
            isNaN(protein)
        ) {
            return res.status(400).json({ message: 'Nutritional values and duration must be numbers.' });
        }

        // Construct the recipe object
        const newRecipe = {
            id: uuid.v4(),
            name,
            username:username,
            ingredients: parsedIngredients,
            steps,
            duration: parseInt(duration, 10),
            servings: parseInt(servings, 10),
            dietaryPreferences,
            calories: parseFloat(calories),
            fat: parseFloat(fat),
            likeCount:0,
            dislikeCount:0,
            carbohydrates: parseFloat(carbohydrates),
            protein: parseFloat(protein),
            finalIngredientList,
            uploadDate: new Date().toISOString(),
            imageUrl: null,
        };

        // Handle image upload
        if (req.file) {
            const imageKey = `recipes/images/${Date.now()}_${path.basename(req.file.originalname)}`;
            const uploadParams = {
                Bucket: BUCKET_NAME,
                Key: imageKey,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            };
            await s3.send(new PutObjectCommand(uploadParams));
            newRecipe.imageUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${imageKey}`;
        }

        // Write the recipe to S3
        const fileKey = 'recipes/recipe.csv';
        let csvData = [];
        if (await fileExists(fileKey)) {
            const existingContent = await readFileFromS3(fileKey);
            csvData = await new Promise((resolve, reject) => {
                parse(existingContent, { columns: true }, (err, output) => {
                    if (err) return reject(err);
                    resolve(output);
                });
            });
        }

        csvData.push(newRecipe);

        const csvContent = await new Promise((resolve, reject) => {
            stringify(csvData, { header: true }, (err, output) => {
                if (err) return reject(err);
                resolve(output);
            });
        });

        await writeFileToS3(fileKey, csvContent);

        res.status(200).json({
            message: 'Recipe uploaded successfully.',
            recipe: newRecipe,
        });
    } catch (error) {
        console.error('Error during upload:', error);
        res.status(500).json({ message: 'Error uploading recipe.', error: error.message });
    }
});






app.delete('/recipes/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { recipeIds } = req.body;

        if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
            return res.status(400).json({ message: 'No recipes selected' });
        }

        const fileKey = 'recipes/recipe.csv';
        if (!await fileExists(fileKey)) {
            return res.status(404).json({ message: 'No recipes found' });
        }

        const existingContent = await readFileFromS3(fileKey);
        let csvData = await new Promise((resolve, reject) => {
            parse(existingContent, { columns: true }, (err, output) => {
                if (err) return reject(err);
                resolve(output);
            });
        });

        // Filter out the recipes that should be deleted, matching the username and recipe ID
        csvData = csvData.filter(recipe => recipe.username !== username || !recipeIds.includes(recipe.id));

        // Write the updated content back to S3
        const csvContent = await new Promise((resolve, reject) => {
            stringify(csvData, { header: true }, (err, output) => {
                if (err) return reject(err);
                resolve(output);
            });
        });

        await writeFileToS3(fileKey, csvContent);

        res.status(200).json({ message: 'Recipes deleted successfully' });
    } catch (error) {
        console.error('Error deleting recipes:', error);
        res.status(500).json({ message: 'Error deleting recipes', error: error.message });
    }
});

app.get('/recipes', async (req, res) => {
    try {
        const fileKey = 'recipes/recipe.csv';
        if (!await fileExists(fileKey)) {
            return res.status(404).json({ message: 'No recipes found' });
        }

        const existingContent = await readFileFromS3(fileKey);
        const recipes = await new Promise((resolve, reject) => {
            parse(existingContent, { columns: true }, (err, output) => {
                if (err) return reject(err);
                resolve(output);
            });
        });

        res.status(200).json({ recipes });
    } catch (error) {
        console.error('Error fetching recipes:', error);
        res.status(500).json({ message: 'Error fetching recipes', error: error.message });
    }
});

// Fetch recipes by username
app.get('/recipes/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const fileKey = 'recipes/recipe.csv';

        if (!await fileExists(fileKey)) {
            return res.status(404).json({ message: 'No recipes found' });
        }

        const existingContent = await readFileFromS3(fileKey);
        const recipes = await new Promise((resolve, reject) => {
            parse(existingContent, { columns: true }, (err, output) => {
                if (err) return reject(err);
                resolve(output);
            });
        });

        // Filter recipes by username
        const filteredRecipes = recipes.filter(recipe => recipe.username === username);

        if (filteredRecipes.length === 0) {
            return res.status(404).json({ message: `No recipes found for user: ${username}` });
        }

        // Return the filtered recipes
        res.status(200).json({ recipes: filteredRecipes });
    } catch (error) {
        console.error('Error fetching recipes by username:', error);
        res.status(500).json({ message: 'Error fetching recipes by username', error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
