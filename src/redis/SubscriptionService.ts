import * as grpc from '@grpc/grpc-js';
import { RedisPubSub } from './RedisPubSub';
import { Notification, SubscriptionRequest } from '../types';

export class SubscriptionService {
    private pubSub: RedisPubSub;

    constructor(pubSub: RedisPubSub) {
        this.pubSub = pubSub;
    }

    public async subscribe(call: grpc.ServerWritableStream<SubscriptionRequest, Notification>) {
        const { client_id, watch_paths } = call.request;

        for (const path of watch_paths) {
            const channel = this.getChannelForPath(path);

            await this.pubSub.subscribe(channel, (message: Notification) => {
                call.write(message);
            });
        }

        call.on('cancelled', () => {
            this.unsubscribe(client_id, watch_paths);
        });
    }

    private async unsubscribe(client_id: string, paths: string[]) {
        for (const path of paths) {
            const channel = this.getChannelForPath(path);
            await this.pubSub.unsubscribe(channel);
        }
    }

    private getChannelForPath(path: string): string {
        return `file_events:${path}`;
    }
}