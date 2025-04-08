import { Server, Socket } from 'socket.io';
import { FileServer } from './FileServer';
import { measureTime } from '../utils';
import { generateChart } from '../utils';
import { PerformanceMetrics } from '../types';

export class SocketHandler {
    private performanceMetrics: PerformanceMetrics[] = [];
    private fileServer: FileServer;

    constructor(io: Server) {
        this.fileServer = new FileServer();
        this.setupSocketIO(io);
    }

    private setupSocketIO(io: Server) {
        io.on('connection', (socket: Socket) => {
            console.log('Novo cliente conectado:', socket.id);

            socket.on('create', async (payload, callback) => {
                const { timeMs } = await measureTime(() => this.fileServer.createFile(payload));
                this.performanceMetrics.push({ operation: `create_${payload.filename}`, timeMs });
                callback({ status: 'success', timeMs });
            });

            socket.on('read', async (payload, callback) => {
                const { result, timeMs } = await measureTime(() => this.fileServer.readFile(payload));
                this.performanceMetrics.push({ operation: `read_${payload.filename}`, timeMs });
                callback({ ...result, timeMs });
            });

            socket.on('write', async (payload, callback) => {
                const { timeMs } = await measureTime(() => this.fileServer.writeFile(payload));
                this.performanceMetrics.push({ operation: `write_${payload.filename}`, timeMs });
                callback({ status: 'success', timeMs });
            });

            socket.on('delete', async (payload, callback) => {
                const { timeMs } = await measureTime(() => this.fileServer.deleteFile(payload));
                this.performanceMetrics.push({ operation: `delete_${payload.filename}`, timeMs });
                callback({ status: 'success', timeMs });
            });

            socket.on('disconnect', async () => {
                console.log('Cliente desconectado:', socket.id);
                if (this.performanceMetrics.length > 0) {
                    await generateChart(this.performanceMetrics);
                    console.log('Gráfico gerado com sucesso!');
                    this.performanceMetrics = [];
                }
            });
        });
    }
}