require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = parseInt(process.env.PORT || '1402', 10);
const host = process.env.HOST || '0.0.0.0';

// Configure multer to store uploaded files temporarily in the 'uploads' folder
const upload = multer({ dest: 'uploads/' });

// System status: "idle" or "processing"
let currentStatus = "idle";

const OUTPUT_FILE = path.join(__dirname, 'output.txt');

app.use(express.json());

// Endpoint 1: Upload a txt file and trigger model processing
app.post('/upload', upload.single('file'), async (req, res) => {
    if (currentStatus === "processing") {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(429).json({ message: "System is busy, please try again later." });
    }

    if (!req.file) {
        return res.status(400).json({ error: "Please attach a file with field name 'file'" });
    }

    try {
        // Read the content of the txt file
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        // Delete the temporary file after reading
        fs.unlinkSync(req.file.path);

        currentStatus = "processing";

        // Read per-request overrides from headers (fallback to .env inside processWithModel)
        const headerReasoningEffort = req.headers['x-reasoning-effort'] || null;
        const headerMaxTokens = req.headers['x-max-tokens'] ? parseInt(req.headers['x-max-tokens'], 10) : null;

        res.json({
            message: "File received and is being processed.",
            reasoning_effort: headerReasoningEffort || process.env.REASONING_EFFORT || null,
            max_tokens: headerMaxTokens || parseInt(process.env.MAX_TOKENS || '2048', 10)
        });

        // Call the model API in the background
        processWithModel(fileContent, { reasoningEffort: headerReasoningEffort, maxTokens: headerMaxTokens });

    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: "Error processing file" });
    }
});

// Endpoint 2: Status check
app.get('/status', (req, res) => {
    res.json({ status: currentStatus });
});

// Endpoint 3: Download the output file produced by the last model call
app.get('/output', (req, res) => {
    if (!fs.existsSync(OUTPUT_FILE)) {
        return res.status(404).json({ error: "No output file available yet. Please upload a file first." });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="output.txt"');
    fs.createReadStream(OUTPUT_FILE).pipe(res);
});

async function processWithModel(userText, overrides = {}) {
    try {
        let systemPrompt = "";
        const instructPath = path.join(__dirname, 'instruct.txt');

        if (fs.existsSync(instructPath)) {
            systemPrompt = fs.readFileSync(instructPath, 'utf8');
        }

        const apiBase = (process.env.API_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, '');
        const apiKey = process.env.API_KEY || "";
        const model = process.env.MODEL || "openai/gpt-3.5-turbo";
        // Per-request header values take priority over .env
        const maxTokens = overrides.maxTokens ?? parseInt(process.env.MAX_TOKENS || '2048', 10);
        const temperature = parseFloat(process.env.TEMPERATURE || '0.7');
        const reasoningEffort = overrides.reasoningEffort ?? process.env.REASONING_EFFORT ?? null; // low | medium | high

        console.log(`[API] Sending request to ${apiBase} using model: ${model}...`);
        if (reasoningEffort) console.log(`[API] Reasoning effort: ${reasoningEffort}`);

        // Build request body
        const requestBody = {
            model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userText }
            ],
            max_tokens: maxTokens,
            temperature
        };

        // Add reasoning parameter if set (supported models: openai/o1, anthropic/claude-3-7-sonnet, etc.)
        if (reasoningEffort) {
            requestBody.reasoning = { effort: reasoningEffort };
        }

        // Requires Node 18+ for native fetch support
        const response = await fetch(`${apiBase}/chat/completions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[API Error] HTTP ${response.status}: ${errText}`);
            fs.writeFileSync(OUTPUT_FILE, `[ERROR] HTTP ${response.status}: ${errText}`, 'utf8');
        } else {
            const data = await response.json();
            const content = data.choices[0]?.message?.content || "";
            console.log("\n[API Response]:\n" + content + "\n");

            // Save result to output.txt
            fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
            console.log(`[API] Output saved to ${OUTPUT_FILE}`);
        }

    } catch (error) {
        console.error("[API Error]:", error.message);
        fs.writeFileSync(OUTPUT_FILE, `[ERROR] ${error.message}`, 'utf8');
    } finally {
        // Reset status when done
        currentStatus = "idle";
        console.log("System status reset to: idle");
    }
}

app.listen(port, host, () => {
    console.log(`Server is listening at http://${host}:${port}`);
    console.log("Endpoint POST /upload : Upload a txt file for processing");
    console.log("Endpoint GET  /status : Check system status");
    console.log("Endpoint GET  /output : Download the output.txt result");
});
