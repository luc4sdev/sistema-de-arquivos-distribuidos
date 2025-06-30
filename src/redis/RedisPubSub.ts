import { createClient, RedisClientType } from 'redis';
import { Notification } from '../types';

export class RedisPubSub {
    private publisher: RedisClientType;
    private subscriber: RedisClientType;
    private subscribedChannels: Map<string, (msg: Notification) => void>;

    constructor() {
        this.publisher = createClient({ url: 'redis://localhost:6379' });
        this.subscriber = this.publisher.duplicate();
        this.subscribedChannels = new Map();

        this.connect();
    }

    private async connect() {
        await this.publisher.connect();
        await this.subscriber.connect();
        console.log('Conectado ao Redis');
    }

    public async publish(channel: string, message: Notification) {
        await this.publisher.publish(channel, JSON.stringify(message));
    }

    public async subscribe(channel: string, callback: (msg: Notification) => void | Promise<void>) {
        if (this.subscribedChannels.has(channel)) {
            return;
        }

        this.subscribedChannels.set(channel, callback);
        await this.subscriber.subscribe(channel, (message) => {
            callback(JSON.parse(message));
        });
    }

    public async unsubscribe(channel: string) {
        await this.subscriber.unsubscribe(channel);
        this.subscribedChannels.delete(channel);
    }

    public async publishToPath(filePath: string, message: Notification) {
        // Publica no caminho específico e em todos os pais
        const paths = this.getPathVariations(filePath);

        for (const path of paths) {
            const channel = `file_events:${path}`;
            await this.publish(channel, message);
        }
    }

    private getPathVariations(filePath: string): string[] {
        const paths: string[] = [];
        let currentPath = filePath.toLowerCase();

        // Adiciona o caminho completo
        paths.push(currentPath);

        // Adiciona todos os caminhos pai
        while (currentPath.includes('/')) {
            currentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
            if (currentPath) paths.push(currentPath);
        }

        // Adiciona o root
        paths.push('');

        return paths;
    }

    public getClient(): RedisClientType {
        return this.publisher;
    }
}