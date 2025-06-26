import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { FileClient } from './FileClient';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);


class FileTransferValidator {
    private fileClient: FileClient;
    private numFiles: number;
    private fileSize: number;
    private tempDir: string;
    private remoteDir: string;

    constructor(
        numFiles: number = 100,
        fileSize: number = 512 * 1024, // 512KB
        tempDir: string = path.join(__dirname, '../../localFiles'),
        remoteDir: string = path.join(__dirname, '../../files')
    ) {
        this.fileClient = new FileClient();
        this.numFiles = numFiles;
        this.fileSize = fileSize;
        this.tempDir = tempDir;
        this.remoteDir = remoteDir;
    }

    private generateRandomContent(): Buffer {
        return crypto.randomBytes(this.fileSize);
    }

    private async setupTestEnvironment(): Promise<void> {
        try {
            if (!fs.existsSync(this.tempDir)) {
                await mkdirAsync(this.tempDir, { recursive: true });
            }
            if (!fs.existsSync(this.remoteDir)) {
                await mkdirAsync(this.remoteDir, { recursive: true });
            }
        } catch (err) {
            console.error('Erro ao configurar ambiente de teste:', err);
            throw err;
        }
    }
    private async cleanupTestEnvironment(): Promise<void> {
        // Limpar arquivos temporários
        const files = await fs.promises.readdir(this.tempDir);
        for (const file of files) {
            try {
                await unlinkAsync(path.join(this.tempDir, file));
            } catch (err) {
                console.warn(`Não foi possível limpar ${file}:`, err);
            }
        }
    }

    public async runValidationTest() {
        await this.setupTestEnvironment();

        const results = {
            totalFiles: this.numFiles,
            successfulTransfers: 0,
            failedTransfers: 0,
            latencies: [] as number[],
            fileDetails: [] as Array<{
                filename: string;
                latency: number;
            }>
        };

        console.log(`Iniciando teste com ${this.numFiles} arquivos de ${this.fileSize / 1024}KB cada`);

        // 1. Criar e transferir arquivos um por um
        for (let i = 0; i < this.numFiles; i++) {
            const filename = `testfile_${i}.dat`;
            const localPath = path.join(this.tempDir, filename);
            const remotePath = path.join(this.remoteDir, filename);

            try {
                // Gerar arquivo local
                const content = this.generateRandomContent();
                await writeFileAsync(localPath, content);

                // Transferir arquivo
                const startTime = process.hrtime();
                await this.fileClient.copyFile(localPath, remotePath);
                const [seconds, nanoseconds] = process.hrtime(startTime);
                const latencyMs = seconds * 1000 + nanoseconds / 1e6;
                results.latencies.push(latencyMs)
                results.fileDetails.push({
                    filename,
                    latency: latencyMs,
                });

                console.log(
                    `Arquivo ${filename} transferido - ` +
                    `Latência: ${latencyMs.toFixed(2)}ms,`
                );

                // Limpar arquivo local após transferência
                await unlinkAsync(localPath);
                results.successfulTransfers++;

            } catch (error) {
                results.failedTransfers++;
                results.latencies.push(0);
                results.fileDetails.push({
                    filename,
                    latency: 0,
                });
                console.error(`Falha ao processar arquivo ${filename}:`, error);
            }
        }

        // 2. Calcular métricas finais
        const totalLatency = results.latencies.reduce((sum, latency) => sum + latency, 0);
        const averageLatency = totalLatency / results.latencies.length;
        const successRate = (results.successfulTransfers / this.numFiles) * 100;

        console.log('\n=== Resultados do Teste ===');
        console.log(`- Arquivos transferidos com sucesso: ${results.successfulTransfers}/${this.numFiles}`);
        console.log(`- Taxa de sucesso: ${successRate.toFixed(2)}%`);
        console.log(`- Latência média por arquivo: ${averageLatency.toFixed(2)}ms`);


        await this.cleanupTestEnvironment();
    }
}

// Executar o teste
(async () => {
    const validator = new FileTransferValidator(
        100,       // Número de arquivos
        512 * 1024 // Tamanho de cada arquivo (512KB)
    );

    try {
        await validator.runValidationTest();
    } catch (error) {
        console.error('Erro durante a execução do teste:', error);
        process.exit(1);
    }
})();