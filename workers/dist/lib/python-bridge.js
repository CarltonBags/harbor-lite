"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PythonBridge = void 0;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
class PythonBridge {
    pythonPath;
    constructor() {
        // Determine the correct path to the Python script
        // In development: process.cwd() is the workers folder
        // On Render: process.cwd() is /app (the workers folder root)
        // The Python folder is always at ./python relative to the workers root
        // Check if we're in the dist folder (production) or root (development)
        const currentDir = __dirname;
        if (currentDir.includes('/dist/')) {
            // Production: __dirname is /app/dist/lib, python is at /app/python
            this.pythonPath = path_1.default.join(currentDir, '../../python/main.py');
        }
        else {
            // Development: __dirname is workers/lib, python is at workers/python
            this.pythonPath = path_1.default.join(currentDir, '../python/main.py');
        }
        console.log(`[PythonBridge] Python script path: ${this.pythonPath}`);
    }
    async runPipeline(pipelineName, data) {
        return new Promise((resolve, reject) => {
            // Serialize data to JSON string
            const jsonData = JSON.stringify(data);
            console.log(`[PythonBridge] Starting pipeline: ${pipelineName}`);
            const python = (0, child_process_1.spawn)('python3', [
                this.pythonPath,
                pipelineName,
                jsonData
            ], {
                // Set the working directory to the python folder for imports to work
                cwd: path_1.default.dirname(this.pythonPath),
                env: {
                    ...process.env,
                    PYTHONPATH: path_1.default.dirname(this.pythonPath)
                }
            });
            let stdout = '';
            let stderr = '';
            python.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            python.stderr.on('data', (data) => {
                const logLine = data.toString();
                stderr += logLine;
                // Forward Python logs to Node.js console
                process.stderr.write(`[Python] ${logLine}`);
            });
            python.on('close', (code) => {
                // Log Python output for debugging
                if (stderr) {
                    console.log(`[PythonBridge] Python logs:\n${stderr}`);
                }
                if (code !== 0) {
                    console.error(`[PythonBridge] Process exited with code ${code}`);
                    reject(new Error(`Python process exited with code ${code}: ${stderr}`));
                }
                else {
                    try {
                        // stdout should contain ONLY the JSON result
                        // stderr contains all the logs
                        const trimmedOutput = stdout.trim();
                        if (!trimmedOutput) {
                            reject(new Error('Python process returned empty output'));
                            return;
                        }
                        const result = JSON.parse(trimmedOutput);
                        if (result.error) {
                            reject(new Error(`Python pipeline error: ${result.error}`));
                        }
                        else {
                            console.log(`[PythonBridge] Pipeline ${pipelineName} completed successfully`);
                            resolve(result);
                        }
                    }
                    catch (e) {
                        console.error(`[PythonBridge] Failed to parse JSON output`);
                        console.error(`[PythonBridge] Raw stdout: ${stdout}`);
                        reject(new Error(`Failed to parse Python output: ${e}`));
                    }
                }
            });
            python.on('error', (err) => {
                reject(new Error(`Failed to start Python process: ${err.message}`));
            });
        });
    }
}
exports.PythonBridge = PythonBridge;
