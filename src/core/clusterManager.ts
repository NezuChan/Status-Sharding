import { Awaitable, ClusterHeartbeatOptions, ClusterManagerCreateOptions, ClusterManagerEvents, ClusterManagerOptions, ClusteringMode, EvalOptions, Serialized } from '../types';
import { ChildProcess, Serializable } from 'child_process';
import { HeartbeatManager } from '../plugins/heartbeat';
import { ReClusterManager } from '../plugins/reCluster';
import { ShardingUtils } from '../other/shardingUtils';
import { PromiseHandler } from '../handlers/promise';
import { ShardingClient } from './clusterClient';
import { Queue } from '../handlers/queue';
import { Worker } from 'worker_threads';
import { Cluster } from './cluster';
import { Guild } from 'discord.js';
import EventEmitter from 'events';
import path from 'path';
import os from 'os';
import fs from 'fs';

export class ClusterManager extends EventEmitter {
	public ready: boolean; // Check if all clusters are ready.
	readonly options: ClusterManagerOptions<ClusteringMode>;
	readonly promise: PromiseHandler; // Promise Handler for the ClusterManager.
	readonly clusters: Map<number, Cluster>; // A collection of all clusters the manager spawned.
	readonly reCluster: ReClusterManager; // ReCluster Manager for the ClusterManager.
	readonly heartbeat: HeartbeatManager; // Heartbeat Manager for the ClusterManager.
	readonly clusterQueue: Queue; // Queue for the ClusterManager.
	// customInstances?: Map<number, Cluster>; // Custom Bot Instances. (maybe?)

	constructor(public file: string, options: ClusterManagerCreateOptions<ClusteringMode>) {
		super();

		if (!file) throw new Error('CLIENT_INVALID_OPTION | No File specified.');

		this.file = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
		if (!fs.statSync(this.file)?.isFile()) throw new Error('CLIENT_INVALID_OPTION | Provided is file is not type of file.');

		if (options.mode !== 'worker' && options.mode !== 'process') throw new RangeError('CLIENT_INVALID_OPTION | Cluster mode must be "worker" or "process".');

		this.options = {
			...options,
			totalShards: options.totalShards === undefined ? -1 : options.totalShards,
			totalClusters: options.totalClusters === undefined ? -1 : options.totalClusters,
			shardsPerClusters: options.shardsPerClusters === undefined ? -1 : options.shardsPerClusters,
			respawn: options.respawn === undefined ? true : options.respawn,
			heartbeat: ShardingUtils.mergeObjects<Required<ClusterHeartbeatOptions>>(options.heartbeat || {}, { maxRestarts: 3, interval: 30000, timeout: 45000, maxMissedHeartbeats: 4 }),
			mode: options.mode === undefined ? 'worker' : options.mode,
			shardList: [], clusterList: [],
			spawnOptions: {
				timeout: options.spawnOptions?.timeout ?? -1,
				delay: options.spawnOptions?.delay ?? 7000,
			},
		};

		process.env.SHARD_LIST = undefined;
		process.env.AUTO_LOGIN = options.autoLogin ? 'true' : undefined;
		process.env.TOTAL_SHARDS = String(options.totalShards);
		process.env.CLUSTER = undefined;
		process.env.CLUSTER_COUNT = String(options.totalClusters);
		process.env.CLUSTER_MANAGER = 'true';
		process.env.CLUSTER_MANAGER_MODE = options.mode;
		process.env.DISCORD_TOKEN = String(options.token) || undefined;
		process.env.MAINTENANCE = undefined;
		process.env.CLUSTER_QUEUE_MODE = options.queueOptions?.auto ? 'auto' : 'manual';

		this.ready = false;
		this.clusters = new Map();

		this.promise = new PromiseHandler();
		this.reCluster = new ReClusterManager(this);
		this.heartbeat = new HeartbeatManager(this);

		this.clusterQueue = new Queue(this.options.queueOptions || {
			auto: true, timeout: this.options.spawnOptions.timeout || this.options.spawnOptions.delay,
		});

		this._debug('[ClusterManager] Initialized successfully.');
	}

	// Spawns multiple internal clusters.
	public async spawn(): Promise<Queue> {
		if (this.options.spawnOptions.delay < 7000) process.emitWarning('Spawn Delay is smaller than 7s, this can cause global rate limits on /gateway/bot', {
			code: 'SHARDING_DELAY',
		});

		if (!this.options.token) throw new Error('CLIENT_INVALID_OPTION | No Token specified.');
		if (this.options.token?.includes('Bot ') || this.options.token?.includes('Bearer ')) this.options.token = this.options.token.slice(this.options.token.indexOf(' ') + 1);

		const cpuCores = os.cpus().length;
		this.options.totalShards = this.options.totalShards !== -1 ? this.options.totalShards : await ShardingUtils.getRecommendedShards(this.options.token) || 1;
		this.options.totalClusters = (this.options.totalClusters === -1) ? (cpuCores > this.options.totalShards ? this.options.totalShards : cpuCores) : this.options.totalClusters;
		this.options.shardsPerClusters = (this.options.shardsPerClusters === -1) ? Math.ceil(this.options.totalShards / this.options.totalClusters) : this.options.shardsPerClusters;

		if (this.options.totalShards < 1) this.options.totalShards = 1;
		if (this.options.totalClusters < 1) this.options.totalClusters = 1;

		if (this.options.totalClusters > this.options.totalShards) throw new Error('CLIENT_INVALID_OPTION | Total Clusters cannot be more than Total Shards.');
		if (this.options.shardsPerClusters > this.options.totalShards) throw new Error('CLIENT_INVALID_OPTION | Shards per Cluster cannot be more than Total Shards.');
		if (this.options.shardsPerClusters > (this.options.totalShards / this.options.totalClusters)) throw new Error('CLIENT_INVALID_OPTION | Shards per Cluster cannot be more than Total Shards divided by Total Clusters.');

		if (!this.options.shardList?.length) this.options.shardList = new Array(this.options.totalShards).fill(0).map((_, i) => i);
		if (this.options.shardsPerClusters) this.options.totalClusters = Math.ceil((this.options.shardList?.length || 0) / this.options.shardsPerClusters) || 1;

		if (!this.options.clusterList?.length) this.options.clusterList = new Array(this.options.totalClusters).fill(0).map((_, i) => i);
		if (this.options.clusterList.length !== this.options.totalClusters) this.options.totalClusters = this.options.clusterList.length;

		if (this.options.totalShards < 1) throw new Error('CLIENT_INVALID_OPTION | Total Shards must be at least 1.');
		if (this.options.totalClusters < 1) throw new Error('CLIENT_INVALID_OPTION | Total Clusters must be at least 1.');
		if (this.options.shardsPerClusters < 1) throw new Error('CLIENT_INVALID_OPTION | Shards Per Cluster must be at least 1.');

		if (this.options.totalShards < this.options.shardList.length) throw new Error('CLIENT_INVALID_OPTION | Shard List is bigger than Total Shards.');
		if (this.options.totalClusters < this.options.clusterList.length) throw new Error('CLIENT_INVALID_OPTION | Cluster List is bigger than Total Clusters.');

		if (this.options.shardsPerClusters > this.options.totalShards) throw new Error('CLIENT_INVALID_OPTION | Shards Per Cluster is bigger than Total Shards.');

		if (this.options.shardList.some((shard) => shard < 0)) throw new Error('CLIENT_INVALID_OPTION | Shard List has invalid shards.');
		if (this.options.clusterList.some((cluster) => cluster < 0)) throw new Error('CLIENT_INVALID_OPTION | Cluster List has invalid clusters.');

		if (this.options.shardList.some((shard) => shard < 0)) throw new Error('CLIENT_INVALID_OPTION | Shard List has invalid shards.');
		if (this.options.clusterList.some((cluster) => cluster < 0)) throw new Error('CLIENT_INVALID_OPTION | Cluster List has invalid clusters.');

		this._debug(`[ClusterManager] Spawning ${this.options.totalClusters} Clusters with ${this.options.totalShards} Shards.`);

		const listOfShardsForCluster = ShardingUtils.chunkArray(this.options.shardList || [], this.options.shardsPerClusters || this.options.totalShards);
		if (listOfShardsForCluster.length !== this.options.totalClusters) this.options.totalClusters = listOfShardsForCluster.length;

		this.options.totalShards = listOfShardsForCluster.reduce((acc, curr) => acc + curr.length, 0);
		this.options.totalClusters = listOfShardsForCluster.length;
		this.options.shardsPerClusters = Math.ceil(this.options.totalShards / this.options.totalClusters);

		for (let i = 0; i < this.options.totalClusters; i++) {
			if (listOfShardsForCluster[i]) {
				this._debug(`[ClusterManager] Added Cluster ${this.options.clusterList?.[i] || i} to the queue with ${listOfShardsForCluster[i]} shards.`);

				this.clusterQueue.add({
					timeout: this.options.spawnOptions.delay * listOfShardsForCluster[i]?.length,
					args: [this.options.spawnOptions.timeout !== -1 ? this.options.spawnOptions.timeout + this.options.spawnOptions.delay * listOfShardsForCluster[i]?.length : this.options.spawnOptions.timeout],
					run: (...timeout: number[]) => this.createCluster(this.options.clusterList?.[i] || i, listOfShardsForCluster[i]).spawn(...timeout),
				});
			}
		}

		return this.clusterQueue.start();
	}

	// Sends a message to all clusters.
	public async broadcast(message: Serializable) {
		const promises = Array.from(this.clusters.values()).map((cluster) => cluster.send(message));
		return Promise.all(promises);
	}

	// Kills all running clusters and respawns them.
	public async respawnAll({ clusterDelay = 5000, respawnDelay = 500, timeout = 30000 }) {
		this.promise.nonces.clear();
		let s = 0; let i = 0;
		this._debug('[ClusterManager] Respawning all clusters.');

		const promises: Promise<ChildProcess | Worker | null | void>[] = [];
		const listOfShardsForCluster = ShardingUtils.chunkArray(this.options.shardList || [], this.options.shardsPerClusters || this.options.totalShards);

		for (const cluster of this.clusters.values()) {
			promises.push(cluster.respawn(respawnDelay, timeout));

			const length = listOfShardsForCluster[i]?.length || this.options.totalShards / this.options.totalClusters;
			if (++s < this.clusters.size && clusterDelay > 0) promises.push(ShardingUtils.delayFor(length * clusterDelay));

			i++;
		}

		await Promise.all(promises);
		return this.clusters;
	}

	// Runs a method with given arguments on the Manager itself.
	public async eval<T, P>(script: string | ((manager: ClusterManager, context: Serialized<P>) => Awaitable<T>), options?: { context?: P, timeout?: number }): Promise<{
		result: Serialized<T> | undefined;
		error: Error | undefined;
	}> {
		let result: Serialized<T> | undefined;
		let error: Error | undefined;

		// Manager is not allowed to crash.
		try {
			result = await eval(typeof script === 'string' ? script : `(${script})(this${options?.context ? ', ' + JSON.stringify(options.context) : ''})`);
		} catch (err) {
			error = err as Error;
		}

		return { result: result, error: error };
	}

	// Evaluates a script on all clusters, or a given cluster, in the context of the Clients.
	public async broadcastEval<T, P>(script: string | ((client: ShardingClient, context: Serialized<P>) => Awaitable<T>), options?: EvalOptions<P>): Promise<(T extends never ? unknown : Serialized<T>)[]> {
		if (this.clusters.size === 0) return Promise.reject(new Error('CLUSTERING_NO_CLUSTERS | No clusters have been spawned.'));
		if ((options?.cluster !== undefined || options?.shard !== undefined) && options?.guildId !== undefined) return Promise.reject(new Error('CLUSTERING_INVALID_OPTION | Cannot use both guildId and cluster/shard options.'));

		if (options?.cluster !== undefined) {
			const clusterIds = Array.isArray(options.cluster) ? options.cluster : [options.cluster];
			if (clusterIds.some((c) => c < 0)) return Promise.reject(new RangeError('CLUSTER_ID_OUT_OF_RANGE | Cluster Ids must be greater than or equal to 0.'));
		}

		if (options?.guildId) options.cluster = ShardingUtils.clusterIdForGuildId(options.guildId, this.options.totalShards, this.options.totalClusters);

		if (options?.shard !== undefined) {
			const shardIds = Array.isArray(options.shard) ? options.shard : [options.shard];
			if (shardIds.some((s) => s < 0)) return Promise.reject(new RangeError('SHARD_ID_OUT_OF_RANGE | Shard Ids must be greater than or equal to 0.'));

			const clusterIds = new Set<number>();
			for (const cluster of this.clusters.values()) {
				if (cluster.shardList.some((shard) => shardIds.includes(shard))) clusterIds.add(cluster.id);
			}

			if (clusterIds.size === 0) return Promise.reject(new Error('CLUSTERING_CLUSTER_NOT_FOUND | No clusters found for the given shard Ids.'));
			else if (clusterIds.size === 1) options.cluster = clusterIds.values().next().value;
			else options.cluster = Array.from(clusterIds);
		}

		const promises: Promise<(T extends never ? unknown : Serialized<T>)>[] = [];
		if (typeof options?.cluster === 'number') {
			const cluster = this.clusters.get(options.cluster);
			if (!cluster) return Promise.reject(new Error('CLUSTERING_CLUSTER_NOT_FOUND | No cluster was found with the given Id.'));

			promises.push(cluster.evalOnClient<T, P>(typeof script === 'string' ? script : `(${script})(this${options?.context ? ', ' + JSON.stringify(options.context) : ''})`));
		} else if (Array.isArray(options?.cluster)) {
			const clusters = Array.from(this.clusters.values()).filter((c) => (options?.cluster as number[])?.includes(c.id));
			if (clusters.length === 0) return Promise.reject(new Error('CLUSTERING_CLUSTER_NOT_FOUND | No clusters were found with the given Ids.'));

			for (const cluster of clusters) {
				promises.push(cluster.evalOnClient<T, P>(typeof script === 'string' ? script : `(${script})(this${options?.context ? ', ' + JSON.stringify(options.context) : ''})`));
			}
		} else {
			for (const cluster of this.clusters.values()) {
				promises.push(cluster.evalOnClient<T, P>(typeof script === 'string' ? script : `(${script})(this${options?.context ? ', ' + JSON.stringify(options.context) : ''})`));
			}
		}

		return Promise.all(promises);
	}

	// Runs a method with given arguments on a given Cluster's Client.
	public async evalOnClusterClient<T, P>(cluster: number, script: string | ((client: ShardingClient, context: Serialized<P>) => Awaitable<T>), options?: Exclude<EvalOptions<P>, 'cluster'>): Promise<T extends never ? unknown : Serialized<T>> {
		if (this.clusters.size === 0) return Promise.reject(new Error('CLUSTERING_NO_CLUSTERS | No clusters have been spawned.'));
		if (typeof cluster !== 'number' || cluster < 0) return Promise.reject(new RangeError('CLUSTER_ID_OUT_OF_RANGE | Cluster Ids must be greater than or equal to 0.'));

		const cl = this.clusters.get(cluster);

		if (!cl) return Promise.reject(new Error('CLUSTERING_CLUSTER_NOT_FOUND | Cluster with id ' + cluster + ' was not found.'));
		return cl.evalOnClient<T, P>(typeof script === 'string' ? script : `(${script})(this${options?.context ? ', ' + JSON.stringify(options.context) : ''})`);
	}

	public async evalOnCluster<T, P>(cluster: number, script: string | ((cluster: Cluster, context: Serialized<P>) => Awaitable<T>), options?: Exclude<EvalOptions<P>, 'cluster'>): Promise<T extends never ? unknown : Serialized<T>> {
		if (this.clusters.size === 0) return Promise.reject(new Error('CLUSTERING_NO_CLUSTERS | No clusters have been spawned.'));
		if (typeof cluster !== 'number' || cluster < 0) return Promise.reject(new RangeError('CLUSTER_ID_OUT_OF_RANGE | Cluster Ids must be greater than or equal to 0.'));

		const cl = this.clusters.get(cluster);

		if (!cl) return Promise.reject(new Error('CLUSTERING_CLUSTER_NOT_FOUND | Cluster with id ' + cluster + ' was not found.'));
		return cl.eval<T, P>(typeof script === 'string' ? script : `(${script})(this${options?.context ? ', ' + JSON.stringify(options.context) : ''})`);
	}

	public async evalOnGuild<T, P>(guildId: string, script: string | ((client: ShardingClient, context: Serialized<P>, guild: Guild) => Awaitable<T>), options?: { context?: P; timeout?: number; }): Promise<T extends never ? unknown : Serialized<T>> {
		if (this.clusters.size === 0) return Promise.reject(new Error('CLUSTERING_NO_CLUSTERS | No clusters have been spawned.'));
		if (typeof guildId !== 'string') return Promise.reject(new TypeError('CLUSTERING_GUILD_ID_INVALID | Guild Ids must be a string.'));

		return this.broadcastEval<T, P>(typeof script === 'string' ? script : `(${script})(this${options?.context ? ', ' + JSON.stringify(options.context) : ''}, this?.guilds?.cache?.get('${guildId}') || (() => { return Promise.reject(new Error('CLUSTERING_GUILD_NOT_FOUND | Guild with ID ${guildId} not found.')); })())`, {
			...options, guildId,
		}).then((e) => e?.[0]);
	}

	// Creates a new cluster. (Using this method is usually not necessary if you use the spawn method.)
	public createCluster(id: number, shardsToSpawn: number[], recluster = false) {
		const cluster = new Cluster(this, id, shardsToSpawn);
		if (!recluster) this.clusters.set(id, cluster);

		// Emitted upon creating a cluster.
		this.emit('clusterCreate', cluster);
		this.heartbeat.getClusterStats(id);

		return cluster;
	}

	// Triggers a maintenance mode for all clusters.
	public triggerMaintenance(reason: string) {
		this._debug('[ClusterManager] Triggering maintenance mode for all clusters.');

		process.env.MAINTENANCE = reason;
		for (const cluster of this.clusters.values()) {
			cluster.triggerMaintenance(reason);
		}
	}

	// Logs out the Debug Messages.
	public _debug(message: string) {
		this.emit('debug', message);
		return message;
	}
}

// Credits for EventEmitter typings: https://github.com/discordjs/discord.js/blob/main/packages/rest/src/lib/RequestManager.ts#L159
export interface ClusterManager {
	emit: (<K extends keyof ClusterManagerEvents>(event: K, ...args: ClusterManagerEvents[K]) => boolean) & (<S extends string | symbol>(event: Exclude<S, keyof ClusterManagerEvents>, ...args: unknown[]) => boolean);
	off: (<K extends keyof ClusterManagerEvents>(event: K, listener: (...args: ClusterManagerEvents[K]) => void) => this) & (<S extends string | symbol>(event: Exclude<S, keyof ClusterManagerEvents>, listener: (...args: unknown[]) => void) => this);
	on: (<K extends keyof ClusterManagerEvents>(event: K, listener: (...args: ClusterManagerEvents[K]) => void) => this) & (<S extends string | symbol>(event: Exclude<S, keyof ClusterManagerEvents>, listener: (...args: unknown[]) => void) => this);
	once: (<K extends keyof ClusterManagerEvents>(event: K, listener: (...args: ClusterManagerEvents[K]) => void) => this) & (<S extends string | symbol>(event: Exclude<S, keyof ClusterManagerEvents>, listener: (...args: unknown[]) => void) => this);
	removeAllListeners: (<K extends keyof ClusterManagerEvents>(event?: K) => this) & (<S extends string | symbol>(event?: Exclude<S, keyof ClusterManagerEvents>) => this);
}
