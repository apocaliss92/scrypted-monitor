import sdk, { ScryptedInterface, ScryptedNativeId } from "@scrypted/sdk";
import { throttle } from "lodash";
import semver from 'semver';

export enum TaskType {
    UpdatePlugins = 'UpdatePlugins',
    RestartPlugins = 'RestartPlugins',
    Diagnostics = 'Diagnostics',
    RestartCameras = 'RestartCameras',
    ReportPluginsStatus = 'ReportPluginsStatus',
}

export interface PluginUpdateCheck {
    updateAvailable?: string;
    updatePublished?: Date;
    versions: NpmVersion[];
}

export interface NpmVersion {
    version: string;
    tag: string;
    time: string;
}

export interface Task {
    name: string;
    type: TaskType;
    cronScheduler: string;
    rebootOnErrors: boolean;
    enabled: boolean;
    beta: boolean;
    skipNotify: boolean;
    maxStats?: number;
    runSystemDiagnostic?: boolean;
    plugins?: string[];
    devices?: string[];
}

const throttles = new Map<string, () => Promise<any>>();
const cache: Record<string, PluginUpdateCheck> = {};

async function checkNpmUpdate(npmPackage: string, npmPackageVersion: string, logger: Console): Promise<NpmVersion[]> {
    try {
        let f = throttles.get(npmPackage);
        if (!f) {
            f = throttle(async () => {
                const response = await fetch(`https://registry.npmjs.org/${npmPackage}`);
                const json = await response.json();
                cache[npmPackage] = json;
                return json;
            }, 60 * 1000);
            throttles.set(npmPackage, f);
        }
        const data = await f();
        if (data.error) {
            return;
        }
        const { time } = data;
        const versions = Object.values(data.versions ?? {}).sort((a: any, b: any) => semver.compare(a.version, b.version)).reverse();
        let latest: any;
        for (const [k, v] of Object.entries(data['dist-tags'])) {
            const found: any = versions.find((version: any) => version.version === v);
            if (found) {
                found.tag = k;
            }
        }
        return (versions as NpmVersion[]).map(version => {
            return {
                ...version,
                tag: version.tag || '',
                time: new Date(time[version.version]).toLocaleDateString(),
            };
        });
    } catch (e) {
        logger.log('Error in checkNpm', e);
    }
}

export const restartPlugin = async (pluginName: string) => {
    const plugins = await sdk.systemManager.getComponent('plugins');
    await plugins.reload(pluginName);
}

interface PluginInfo {
    clientsCount: number;
    pid: number;
    rpcObjects: number;
    pendingResults: number;
}

interface PluginStats {
    rpcObjects: { name: string, count: number }[],
    pendingResults: { name: string, count: number }[],
    connections: { name: string, count: number }[],
    cluster?: {
        workers: { name: string, count: number }[],
        devices: { name: string, count: number }[],
    }
}

export interface ForkOptions {
    name?: string;
    runtime?: string;
    filename?: string;
    id?: string;
    nativeId?: ScryptedNativeId;
    clusterWorkerId?: string;
    labels?: {
        require?: string[];
        any?: string[];
        prefer?: string[];
    };
}

export interface ClusterFork {
    runtime?: ForkOptions['runtime'];
    labels?: ForkOptions['labels'];
    id?: ForkOptions['id'];
    clusterWorkerId: ForkOptions['clusterWorkerId'];
}

export interface ClusterWorker {
    name: string;
    id: string;
    labels: string[];
    forks: ClusterFork[];
}

export const getPluginStats = async (maxStats = 5) => {
    const plugins = await sdk.systemManager.getComponent(
        "plugins"
    );
    const stats: PluginStats = {
        rpcObjects: [],
        connections: [],
        pendingResults: [],
    }

    const pluginNames = Object.keys(sdk.systemManager.getSystemState())
        .filter(id => {
            const d = sdk.systemManager.getDeviceById(id);
            return d.interfaces.includes(ScryptedInterface.ScryptedPlugin);
        }).map(pluginId => {
            const plugin = sdk.systemManager.getDeviceById(pluginId);
            return plugin.info.manufacturer;
        });

    for (const pluginName of pluginNames) {
        const pluginStats: PluginInfo = await plugins.getPluginInfo(pluginName);
        stats.rpcObjects.push({ name: pluginName, count: pluginStats.rpcObjects });
        stats.connections.push({ name: pluginName, count: pluginStats.clientsCount });
        stats.pendingResults.push({ name: pluginName, count: pluginStats.pendingResults });
    }

    stats.rpcObjects = stats.rpcObjects.filter(p => !!p.count).sort((a, b) => b.count - a.count).slice(0, maxStats);
    stats.connections = stats.connections.filter(p => !!p.count).sort((a, b) => b.count - a.count).slice(0, maxStats);
    stats.pendingResults = stats.pendingResults.filter(p => !!p.count).sort((a, b) => b.count - a.count).slice(0, maxStats);

    const clusterFork = await sdk.systemManager.getComponent('cluster-fork');
    if (clusterFork) {
        const clusterWorkers = await clusterFork.getClusterWorkers() as Record<string, ClusterWorker>;
        const clustersInfo = Object.entries(clusterWorkers).map(([_, info]) => ({
            name: info.name,
            forks: info.forks
        }));

        const devicesData: Record<string, { name: string, count: number }> = {};

        for (const worker of Object.values(clusterWorkers)) {
            for (const fork of worker.forks) {
                const id = fork.id;
                let d = devicesData[id];
                if (!d) {
                    d = {
                        name: sdk.systemManager.getDeviceById(id)?.name || 'Unknown Device',
                        count: 0,
                    };
                    devicesData[id] = d;
                }
                d.count++;
            }
        }

        stats.cluster = {
            workers: clustersInfo.map(cluster => ({
                name: cluster.name,
                count: cluster.forks.length
            })).slice(0, maxStats),
            devices: Object.values(devicesData).map(device => ({
                name: device.name,
                count: device.count
            })).slice(0, maxStats)
        }
    }

    return stats;
}

export const updatePlugin = async (
    logger: Console,
    pluginName: string,
    currentVersion: string,
    beta?: boolean
) => {
    const versions = await checkNpmUpdate(pluginName, currentVersion, logger);

    if (!versions) {
        logger.log(`No data found for plugin ${pluginName}`);
        return;
    }

    let versionToUse = versions[0];
    if (versionToUse.tag === 'beta' && !beta) {
        versionToUse = versions.find(version => version.tag === 'latest');
    }

    let updated: boolean;
    let newVersion: string;
    if (versionToUse.version !== currentVersion) {
        updated = true;
        newVersion = versionToUse.version;
        logger.log(`Updating ${pluginName} to version ${newVersion}`);
        const plugins = await sdk.systemManager.getComponent('plugins');
        await plugins.installNpm(pluginName, newVersion);
    } else {
        updated = false;
        logger.log(`Plugin ${pluginName} is already to latest version ${currentVersion}`);
    }

    return { updated, newVersion };

}

export const getTaskKeys = (taskName: string) => {
    const taskTypeKey = `task:${taskName}:type`;
    const taskDevicesKey = `task:${taskName}:devices`;
    const taskPluginsKey = `task:${taskName}:plugins`;
    const taskCronKey = `task:${taskName}:cron`;
    const taskRebootKey = `task:${taskName}:reboot`;
    const taskEnabledKey = `task:${taskName}:enabled`;
    const taskSystemDiagnostic = `task:${taskName}:systemDiagnostic`;
    const taskBetaKey = `task:${taskName}:beta`;
    const taskMaxStatsKey = `task:${taskName}:maxStats`;
    const taskSkipNotify = `task:${taskName}:skipNotify`;

    return {
        taskTypeKey,
        taskDevicesKey,
        taskPluginsKey,
        taskCronKey,
        taskRebootKey,
        taskEnabledKey,
        taskSystemDiagnostic,
        taskBetaKey,
        taskMaxStatsKey,
        taskSkipNotify,
    }
}

export interface ValidationResult { stepName: string, message?: string }
export const runValidate = async (diagnosticsPlugin: any, console: Console, deviceId?: string) => {
    const originalValidate = diagnosticsPlugin.validate;
    const originalWarnStep = diagnosticsPlugin.warnStep;
    const okSteps: ValidationResult[] = [];
    const warnSteps: ValidationResult[] = [];
    const errorSteps: ValidationResult[] = [];
    diagnosticsPlugin.validate = async (_: Console, stepName: string, step: Promise<any> | (() => Promise<any>)) => {
        const newConsole = {
            log: (message?: any, ...optionalParams: any[]) => {
                const result = optionalParams[0];
                if (result?.includes('31m')) {
                    errorSteps.push({ stepName });
                }
                if (result?.includes('32m')) {
                    okSteps.push({ stepName });
                }
                // console.log(message, ...optionalParams);
            },
            error: (message?: any, ...optionalParams: any[]) => {
                const text = optionalParams[1];
                errorSteps.push({ stepName, message: text });
                // console.log(message, ...optionalParams);
            }
        }
        diagnosticsPlugin.warnStep = (console: Console, result: string) => {
            warnSteps.push({ stepName, message: result });
            // originalWarnStep(console, result);
        }
        await originalValidate(newConsole, stepName, step);
    };

    if (deviceId) {
        await diagnosticsPlugin.storageSettings.putSetting('testDevice', deviceId);
        await diagnosticsPlugin.validateDevice();
    } else {
        await diagnosticsPlugin.validateSystem();
    }

    diagnosticsPlugin.validate = originalValidate;
    diagnosticsPlugin.warnStep = originalWarnStep;

    let text = '';
    if (!warnSteps.length && !errorSteps.length) {
        text = 'All good';
    } else {
        if (warnSteps.length) {
            text = `Warnings: ${warnSteps.map(step => step.stepName)}`;
        }

        if (errorSteps.length) {
            if (warnSteps.length) {
                text += ` - `;
            }
            text += `Errors: ${errorSteps.map(step => step.stepName)}`;
        }
    }

    return { okSteps, warnSteps, errorSteps, text };
}

export const getTaskChecksum = (task: Task) => {
    return JSON.stringify(task);
}