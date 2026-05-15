#!/usr/bin/env node

import { createServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = process.cwd();

const configFile = path.resolve(projectRoot, 'dbeditor.json');

if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify({
        projects: [
            {
                name: 'MyDatabase',
                schemaPath: './schemas/database.json',
                dialect: 'mysql',
                output: {
                    mode: 'ddl-files',
                    destinationPath: './schemas/sql',
                    destinationClear: false,
                    sqlComment: true,
                    sqlIndent: '    ',
                    statementTerminator: ';'
                },
                autoGenerate: false
            }
        ],
        server: {
            port: 5174
        },
        browser: {
            open: false
        }
    }, null, 2));
    console.log('dbeditor.json created');
}

const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

process.env.DBEDITOR_PROJECT_ROOT = projectRoot;
process.env.DBEDITOR_CONFIG_FILE = configFile;

let openBrowser = false;
let serverPort = 5174;
const serverHost = 'localhost';

if (config) {
    if (config.server && config.server.port) {
        serverPort = config.server.port;
    }
    if (config.browser && config.browser.open) {
        openBrowser = true;
    }
}

createServer({
    configFile: path.resolve(__dirname, '../vite.config.ts'),
    root: path.resolve(__dirname, '..'),
}).then(server => {
    return new Promise((resolve, reject) => {
        server.httpServer.on('error', err => reject(err));
        server.listen(serverPort).then(resolve).catch(reject);
    });
}).then(() => {
    console.log(`DB Editor running at http://${serverHost}:${serverPort}`);
    if (openBrowser) {
        void open(`http://${serverHost}:${serverPort}`);
    }
}).catch(err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${serverPort} already in use`);
    } else {
        console.error('Failed to start DB Editor:', err);
    }
    process.exit(1);
});