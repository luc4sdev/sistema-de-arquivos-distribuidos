import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { FileClient } from './FileClient';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

class ConcurrentFileTransferValidator {
    private fileClient: FileClient;
    private numFiles: number;
    private fileSize: number;
    private tempDir: string;
    private remoteDir: string;
    private concurrencyLimit: number;

    constructor(
        numFiles: number = 100,
        fileSize: number = 10 * 1024, // 10KB (arquivos pequenos)
        tempDir: string = path.join(__dirname, '../../localFiles'),
        remoteDir: string = path.join(__dirname, '../../files'),
        concurrencyLimit: number = 10 // Limite padrão de concorrência
    ) {
        this.fileClient = new FileClient();
        this.numFiles = numFiles;
        this.fileSize = fileSize;
        this.tempDir = tempDir;
        this.remoteDir = remoteDir;
        this.concurrencyLimit = concurrencyLimit;
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
        try {
            if (fs.existsSync(this.tempDir)) {
                const files = await fs.promises.readdir(this.tempDir);
                await Promise.all(files.map(file =>
                    unlinkAsync(path.join(this.tempDir, file)).catch(err =>
                        console.warn(`Não foi possível limpar ${file}:`, err)
                    )
                ));
            }
        } catch (err) {
            console.error('Erro durante limpeza:', err);
        }
    }

    // Função para limitar a concorrência
    private async runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
        const results: T[] = [];
        const executing: Promise<void>[] = [];

        for (const task of tasks) {
            const p = task().then(result => {
                results.push(result);
            });

            const e: Promise<void> = p.then(() => {
                executing.splice(executing.indexOf(e), 1);
            });

            executing.push(e);

            if (executing.length >= limit) {
                await Promise.race(executing);
            }
        }

        await Promise.all(executing);
        return results;
    }

    public async runConcurrentValidationTest() {
        await this.setupTestEnvironment();

        const results = {
            totalFiles: this.numFiles,
            successfulTransfers: 0,
            failedTransfers: 0,
            latencies: [] as number[],
            fileDetails: [] as Array<{
                filename: string;
                latency: number;
                success: boolean;
                error?: string;
            }>,
            startTime: process.hrtime(),
            totalTimeMs: 0
        };

        console.log(`Iniciando teste CONCORRENTE com ${this.numFiles} arquivos de ${this.fileSize / 1024}KB cada`);
        console.log(`Limite de concorrência: ${this.concurrencyLimit}`);

        const transferTasks = Array.from({ length: this.numFiles }, (_, i) => {
            const filename = `concurrent_${i}.dat`;
            const localPath = path.join(this.tempDir, filename);
            const remotePath = path.join(this.remoteDir, filename);

            return async () => {
                const fileResult = {
                    filename,
                    latency: 0,
                    success: false,
                    error: undefined as string | undefined
                };

                try {
                    // Gerar arquivo local
                    const content = this.generateRandomContent();
                    await writeFileAsync(localPath, content);

                    // Transferir arquivo
                    const startTime = process.hrtime();
                    await this.fileClient.copyFile(
                        localPath,
                        remotePath
                    );
                    const [seconds, nanoseconds] = process.hrtime(startTime);
                    const latencyMs = seconds * 1000 + nanoseconds / 1e6;
                    fileResult.latency = latencyMs;


                    // Limpar arquivo local
                    await unlinkAsync(localPath);
                    fileResult.success;
                    return fileResult;
                } catch (error) {
                    fileResult.error = String(error);
                    return fileResult;
                }
            };
        });

        // Executar todas as tarefas com controle de concorrência
        const fileResults = await this.runWithConcurrency(transferTasks, this.concurrencyLimit);

        // Processar resultados
        results.fileDetails = fileResults;
        results.successfulTransfers = fileResults.filter(r => r.success).length;
        results.failedTransfers = fileResults.filter(r => !r.success).length;
        results.latencies = fileResults.map(r => r.latency);

        // Calcular tempo total
        const [seconds, nanoseconds] = process.hrtime(results.startTime);
        results.totalTimeMs = seconds * 1000 + nanoseconds / 1e6;

        // Calcular métricas
        const totalLatency = results.latencies.reduce((sum, latency) => sum + latency, 0);
        const averageLatency = results.latencies.length > 0
            ? totalLatency / results.latencies.length
            : 0;
        const successRate = (results.successfulTransfers / this.numFiles) * 100;
        const throughput = results.totalTimeMs > 0
            ? (results.successfulTransfers / (results.totalTimeMs / 1000))
            : 0;

        console.log('\n=== Resultados do Teste Concorrente ===');
        console.log(`- Arquivos transferidos com sucesso: ${results.successfulTransfers}/${this.numFiles}`);
        console.log(`- Taxa de sucesso: ${successRate.toFixed(2)}%`);
        console.log(`- Latência média por arquivo: ${averageLatency.toFixed(2)}ms`);
        console.log(`- Tempo total de execução: ${results.totalTimeMs.toFixed(2)}ms`);
        console.log(`- Throughput: ${throughput.toFixed(2)} arquivos/segundo`);
        console.log(`- Concorrência máxima: ${this.concurrencyLimit}`);

        await this.cleanupTestEnvironment();
        this.fileClient.disconnect();
    }
}

// Executar o teste
(async () => {
    try {
        const validator = new ConcurrentFileTransferValidator(
            1000,      // Número de arquivos
            10 * 1024, // 10KB (tamanho pequeno)
        );
        await validator.runConcurrentValidationTest();
    } catch (error) {
        console.error('Erro durante a execução do teste concorrente:', error);
        process.exit(1);
    }
})();