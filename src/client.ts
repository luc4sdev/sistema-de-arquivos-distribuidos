import * as fs from 'fs';
import * as path from 'path';
import { Cli } from './client/Cli';

async function main() {
    const cli = new Cli();

    try {
        const outputDir = path.resolve(__dirname, '../', 'localFiles');
        console.log(outputDir)
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        await cli.start();
    } catch (error) {
        console.error('Erro no cliente:', error);
    }
}

main();