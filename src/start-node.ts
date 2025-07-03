import { RedisPubSub } from './redis/RedisPubSub';
import { MetadataService } from './server/metadataService';
import { ReplicationService } from './server/replicationService';

const nodeId = process.env.NODE_ID || 'node1';
const storagePath = process.env.STORAGE_PATH || './nodes';

(async () => {
    const pubSub = new RedisPubSub();
    const redisClient = pubSub.getClient();
    const metadataService = new MetadataService(redisClient);
    const replicationService = new ReplicationService(metadataService, pubSub, storagePath);
    await replicationService.initialize();
    console.log(`[NODE] ${nodeId} iniciado com sucesso como nó de replicação.`);
})();
