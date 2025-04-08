import express, { Express, Request, Response } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { FileServer } from './FileServer';
import { SocketHandler } from './SocketHandler';

export class Server {
    private app: Express;
    private httpServer: HttpServer;
    private io: SocketServer;
    private fileServer: FileServer;

    constructor() {
        this.app = express();
        this.httpServer = createServer(this.app);
        this.io = new SocketServer(this.httpServer);
        this.fileServer = new FileServer();
        this.setupMiddleware();
        this.setupRoutes();
        new SocketHandler(this.io);
    }

    private setupMiddleware() {
        this.app.use(express.json());
    }

    private setupRoutes() {
        this.app.get('/files', async (_req: Request, res: Response) => {
            try {
                const files = await this.fileServer.listFiles();
                res.json(files);
            } catch (err) {
                res.status(500).json({ error: (err as Error).message });
            }
        });
    }

    public start(port: number) {
        this.httpServer.listen(port, () => {
            console.log(`Servidor rodando na porta ${port}`);
        });
    }
}