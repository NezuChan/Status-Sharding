import { ClusterClientData } from '../types';
import { workerData } from 'worker_threads';

export function getInfo() {
	const clusterMode = process.env.CLUSTER_MANAGER_MODE;
	if (clusterMode !== 'worker' && clusterMode !== 'process') throw new Error('NO_CLUSTER_MANAGER_MODE | ClusterManager Mode is not defined in the environment variables.');

	let data: ClusterClientData;

	if (clusterMode === 'process') {
		const shardList: number[] = [];

		for (const cl of process.env?.SHARD_LIST?.split(',') || []) {
			shardList.push(Number(cl));
		}

		data = {
			ShardList: shardList,
			TotalShards: Number(process.env.TOTAL_SHARDS),
			ClusterCount: Number(process.env.CLUSTER_COUNT),
			ClusterId: Number(process.env.CLUSTER),
			ClusterManagerMode: clusterMode,
			Maintenance: process.env.MAINTENANCE,
			ClusterQueueMode: process.env.CLUSTER_QUEUE_MODE,
			FirstShardId: shardList[0],
			LastShardId: shardList[shardList.length - 1],
			AutoLogin: process.env.AUTO_LOGIN === 'true',
			Token: process.env.DISCORD_TOKEN as string,
		};
	} else {
		data = {
			ShardList: workerData.SHARD_LIST,
			TotalShards: workerData.TOTAL_SHARDS,
			ClusterCount: workerData.CLUSTER_COUNT,
			ClusterId: workerData.CLUSTER,
			ClusterManagerMode: clusterMode,
			Maintenance: workerData.MAINTENANCE,
			ClusterQueueMode: workerData.CLUSTER_QUEUE_MODE,
			FirstShardId: workerData.SHARD_LIST[0],
			LastShardId: workerData.SHARD_LIST[workerData.SHARD_LIST.length - 1],
			AutoLogin: workerData.AUTO_LOGIN,
			Token: workerData.DISCORD_TOKEN,
		};
	}

	return data;
}
