import sdk, { MediaObject, ObjectDetection, ScryptedInterface, ScryptedNativeId, Settings, Image, ClusterForkInterface, } from "@scrypted/sdk";
import { throttle } from "lodash";
import semver from 'semver';

export enum TaskType {
    UpdatePlugins = 'UpdatePlugins',
    RestartPlugins = 'RestartPlugins',
    Diagnostics = 'Diagnostics',
    RestartCameras = 'RestartCameras',
    ReportPluginsStatus = 'ReportPluginsStatus',
    ReportHaBatteryStatus = 'ReportHaBatteryStatus',
    ReportHaConsumables = 'ReportHaConsumables',
    TomorrowEventsHa = 'TomorrowEventsHa',
    RestartScrypted = 'RestartScrypted',
    ReportHaUnavailableEntities = 'ReportHaUnavailableEntities',
    // CamerasRecordingSchedule = 'CamerasRecordingSchedule',
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

export enum NotificationPriority {
    VeryLow = "VeryLow",
    Low = "Low",
    Normal = "Normal",
    High = "High",
    Emergency = "Emergency"
}

export const priorityMap = {
    [NotificationPriority.VeryLow]: -2,
    [NotificationPriority.Low]: -1,
    [NotificationPriority.Normal]: 0,
    [NotificationPriority.High]: 1,
    [NotificationPriority.Emergency]: 2,
}


export interface Task {
    name: string;
    type: TaskType;
    cronScheduler: string;
    rebootOnErrors: boolean;
    enabled: boolean;
    beta: boolean;
    skipNotify: boolean;
    checkAllPlugins?: boolean;
    maxStats?: number;
    runSystemDiagnostic?: boolean;
    plugins?: string[];
    devices?: string[];
    additionalNotifiers?: string[];
    batteryThreshold?: number;
    calendarDaysInFuture?: number;
    unavailableTime?: number;
    entitiesToAlwaysReport?: string[];
    entitiesToExclude?: string[];
    calendarEntity?: string;
    priority?: NotificationPriority;
    script?: string;
}

const throttles = new Map<string, () => Promise<any>>();
const cache: Record<string, PluginUpdateCheck> = {};

const checkNpmUpdate = async (npmPackage: string, npmPackageVersion: string, logger: Console): Promise<NpmVersion[]> => {
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

export const getStorageInfo = async () => {
    const scryptedNvrSettingsId = Object.keys(sdk.systemManager.getSystemState())
        .find(id => {
            const d = sdk.systemManager.getDeviceById(id);
            return (d.interfaces.includes(ScryptedInterface.ScryptedSettings) || d.interfaces.includes("SystemSettings")) && d.name === 'Scrypted NVR';
        });

    const scryptedNvrSettingsDevice = sdk.systemManager.getDeviceById<Settings>(scryptedNvrSettingsId);
    const settings = await scryptedNvrSettingsDevice.getSettings();

    const freeSpaceSetting = settings.find(setting => setting.key === 'freeSpace');
    const cameraStatsSetting = settings.find(setting => setting.key === 'cameraStats');
    const licenseCountSetting = settings.find(setting => setting.key === 'licenseCount');

    const spaceFreePercentage = (Number(freeSpaceSetting.value) * 100 / Number(freeSpaceSetting.range[1])).toFixed(1);

    const freeSpace = `${freeSpaceSetting.value}/${freeSpaceSetting.range[1]} ${freeSpaceSetting.placeholder} (${spaceFreePercentage}%)`;
    const recordingCameras = cameraStatsSetting.value as string;
    const availableLicenses = licenseCountSetting.value as string;

    return { freeSpace, recordingCameras, availableLicenses };
}

interface PluginInfo {
    clientsCount: number;
    pid: number;
    rpcObjects: number;
    pendingResults: number;
}

interface PluginStats {
    currentObjectDetections: string[];
    currentMotionDetections: string[];
    currentActiveStreams: number;
    rpcObjects: { name: string, count: number }[],
    pendingResults: { name: string, count: number }[],
    connections: { name: string, count: number }[],
    cluster?: {
        workers: { name: string, count: number }[],
        devices: { name: string, count: number }[],
    }
    benchmark: Benchmark;
    freeSpace: string;
    recordingCameras: string;
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
    mode: 'server' | 'client';
    forks: ClusterFork[];
}

export const getAllPlugins = () => {
    const pluginNames = Object.keys(sdk.systemManager.getSystemState())
        .filter(id => {
            const d = sdk.systemManager.getDeviceById(id);
            return d.interfaces.includes(ScryptedInterface.ScryptedPlugin);
        }).map(pluginId => {
            const plugin = sdk.systemManager.getDeviceById(pluginId);
            return plugin.info.manufacturer;
        });

    return pluginNames;
}

export const getRpcData = async () => {
    const pluginNames = getAllPlugins();
    const rpcObjects: { name: string, count: number }[] = [];
    const pendingResults: { name: string, count: number }[] = [];
    const connections: { name: string, count: number }[] = [];

    const plugins = await sdk.systemManager.getComponent(
        "plugins"
    );

    for (const pluginName of pluginNames) {
        const pluginStats: PluginInfo = await plugins.getPluginInfo(pluginName);
        rpcObjects.push({ name: pluginName, count: pluginStats.rpcObjects });
        connections.push({ name: pluginName, count: pluginStats.clientsCount });
        pendingResults.push({ name: pluginName, count: pluginStats.pendingResults });
    }

    return {
        rpcObjects,
        connections,
        pendingResults,
    };
}

export const getPluginStats = async (maxStats = 5) => {
    const stats: PluginStats = {
        currentObjectDetections: [],
        currentMotionDetections: [],
        currentActiveStreams: 0,
        rpcObjects: [],
        connections: [],
        pendingResults: [],
        benchmark: {
            detectorsStats: [],
            clusterDps: undefined
        },
        freeSpace: '-',
        recordingCameras: '-'
    }

    const videoAnalysisPlugin = sdk.systemManager.getDeviceByName('Video Analysis Plugin') as unknown as Settings;
    if (videoAnalysisPlugin) {
        const settings = await videoAnalysisPlugin.getSettings();
        const activeObjectDetections = settings.find(item => item.key === 'activeObjectDetections');
        stats.currentObjectDetections = (activeObjectDetections.value ?? []) as string[]
        const activeMotionDetections = settings.find(item => item.key === 'activeMotionDetections');
        stats.currentMotionDetections = (activeMotionDetections.value ?? []) as string[]
    }

    const adaptiveStreamingPlugin = sdk.systemManager.getDeviceByName('Adaptive Streaming') as unknown as Settings;
    if (adaptiveStreamingPlugin) {
        const settings = await adaptiveStreamingPlugin.getSettings();
        const activeStreams = settings.find(item => item.key === 'active');
        stats.currentActiveStreams = (activeStreams.value ?? []) as number;
    }
    const { connections, pendingResults, rpcObjects } = await getRpcData();

    stats.rpcObjects = rpcObjects.filter(p => !!p.count).sort((a, b) => b.count - a.count).slice(0, maxStats);
    stats.connections = connections.filter(p => !!p.count).sort((a, b) => b.count - a.count).slice(0, maxStats);
    stats.pendingResults = pendingResults.filter(p => !!p.count).sort((a, b) => b.count - a.count).slice(0, maxStats);

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

    stats.benchmark = await runBenchmark();
    const { freeSpace, recordingCameras } = await getStorageInfo();
    stats.recordingCameras = recordingCameras;
    stats.freeSpace = freeSpace;

    return stats;
}

export const pluginHasUpdate = async (
    logger: Console,
    pluginName: string,
    currentVersion: string,
    beta?: boolean
) => {
    let newVersion: string;

    const versions = await checkNpmUpdate(pluginName, currentVersion, logger);

    if (!versions) {
        return { newVersion, versions, isBeta: false };
    }

    let versionToUse = versions[0];
    if (versionToUse.tag === 'beta' && !beta) {
        versionToUse = versions.find(version => version.tag === 'latest');
    }

    if (versionToUse.version !== currentVersion) {
        newVersion = versionToUse.version;
        logger.log(`New version available for ${pluginName}: ${newVersion}`);
    }
    const isBeta = versionToUse.tag === 'beta';

    return { newVersion, versions, isBeta };
}

export const updatePlugin = async (
    logger: Console,
    pluginName: string,
    currentVersion: string,
    beta?: boolean
) => {
    const { newVersion, versions, isBeta } = await pluginHasUpdate(logger, pluginName, currentVersion, beta);

    if (!versions) {
        logger.log(`No data found for plugin ${pluginName}`);
        return;
    }

    if (newVersion) {
        logger.log(`Updating ${pluginName} to version ${newVersion}`);
        const plugins = await sdk.systemManager.getComponent('plugins');
        await plugins.installNpm(pluginName, newVersion);
    } else {
        logger.log(`Plugin ${pluginName} is already to latest version ${currentVersion}`);
    }

    return { newVersion, isBeta, versions };
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
    const taskCheckAllPluginsVersion = `task:${taskName}:checkAllPlugins`;
    const taskBatteryThreshold = `task:${taskName}:batteryThreshold`;
    const taskCalendarDaysInFuture = `task:${taskName}:calendarDaysInFuture`;
    const taskEntitiesToAlwaysReport = `task:${taskName}:entitiesToAlwaysReport`;
    const taskEntitiesToExclude = `task:${taskName}:entitiesToExclude`;
    const taskAdditionalNotifiers = `task:${taskName}:additionalNotifiers`;
    const taskCalendarEntity = `task:${taskName}:calendarEntity`;
    const tasksUnavailableTime = `task:${taskName}:tasksUnavailableTime`;

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
        taskCheckAllPluginsVersion,
        taskBatteryThreshold,
        taskEntitiesToAlwaysReport,
        taskEntitiesToExclude,
        taskAdditionalNotifiers,
        taskCalendarEntity,
        tasksUnavailableTime,
        taskCalendarDaysInFuture,
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

export const restartScrypted = async () => {
    const serviceControl = await sdk.systemManager.getComponent("service-control");
    await serviceControl.exit().catch(() => { });
    await serviceControl.restart();
}

interface DetectorStats {
    name: string;
    time: string;
    detections: number;
    detectionRate: string;
}

interface Benchmark {
    clusterDps?: number;
    detectorsStats: DetectorStats[]
}

export const availableObjectDetectors = [
    '@scrypted/openvino',
    '@scrypted/coreml',
    '@scrypted/onnx',
    '@scrypted/tensorflow-lite',
    '@scrypted/rknn',
];

const runDetector = async (props: {
    d: ObjectDetection,
    image: Image & MediaObject,
    simulatedCameras: number,
    batchesPerCamera: number,
    batch: number,
    logProgress?: any
}) => {
    let completedDetections = 0;
    const { d, image, batch, batchesPerCamera, simulatedCameras, logProgress } = props;
    const model = await d.getDetectionModel();
    logProgress && console.log('Model', model);
    const bytes = Buffer.alloc(model.inputSize[0] * model.inputSize[1] * 3);
    const media = await sdk.mediaManager.createMediaObject(bytes, 'x-scrypted/x-scrypted-image', {
        sourceId: image.sourceId,
        width: model.inputSize[0],
        height: model.inputSize[1],
        ffmpegFormats: true,
        format: null,
        toBuffer: async (options) => bytes,
        toImage: undefined,
        close: () => image.close(),
    })
    const start = Date.now();
    let detections = 0;
    const totalDetections = simulatedCameras * batchesPerCamera * batch;

    logProgress && console.log("Starting benchmark...");

    let lastLog = start;
    const simulateCameraDetections = async () => {
        for (let i = 0; i < batchesPerCamera; i++) {
            await Promise.all([
                d.detectObjects(media, { batch }),
                d.detectObjects(media),
                d.detectObjects(media),
                d.detectObjects(media),
            ]);
            detections += batch;
            completedDetections += batch;
            if (logProgress) {
                const now = Date.now();
                if (now - lastLog > 3000) {
                    lastLog = now;
                    logProgress(detections, totalDetections, start);
                }
            }
        }
    };

    const simulated = [];
    for (let i = 0; i < simulatedCameras; i++) {
        simulated.push(simulateCameraDetections());
    }

    await Promise.all(simulated);

    return completedDetections;
}

const getTestImage = async () => {
    const mo = await sdk.mediaManager.createMediaObjectFromUrl('https://user-images.githubusercontent.com/73924/230690188-7a25983a-0630-44e9-9e2d-b4ac150f1524.jpg');
    const image = await sdk.mediaManager.convertMediaObject<Image & MediaObject>(mo, 'x-scrypted/x-scrypted-image');

    return image;
}

export const runBenchmark = async (): Promise<Benchmark> => {
    const os = require('os');
    const detectorsStats: DetectorStats[] = [];

    const image = await getTestImage();
    const simulatedCameras = 4;
    const batch = 4;
    const batchesPerCamera = 125;

    const logProgress = (current: number, total: number, startTime: number) => {
        const percentage = Math.floor((current / total) * 100);
        const elapsedTime = (Date.now() - startTime) / 1000;
        const estimatedTotalTime = (elapsedTime / current) * total;
        const remainingTime = Math.max(0, estimatedTotalTime - elapsedTime);
        console.log(`Progress: ${percentage}% - Est. remaining time: ${remainingTime.toFixed(1)}s`);
    }

    const getCPUInfo = () => {
        try {
            const cpus = os.cpus();
            return cpus[0].model;
        } catch (error) {
            return 'Not found';
        }
    }

    const getMemoryInfo = () => {
        try {
            const totalMem = os.totalmem() / (1024 * 1024 * 1024);
            const freeMem = os.freemem() / (1024 * 1024 * 1024);
            return `Total: ${totalMem.toFixed(2)} GB, Free: ${freeMem.toFixed(2)} GB`;
        } catch (error) {
            return 'Not found';
        }
    }

    console.log('########################');
    console.log(new Date().toLocaleString());
    console.log('########################');
    console.log('CPU Model:', getCPUInfo());
    console.log('Memory:', getMemoryInfo());
    console.log('OS Release:', os.release() || 'Not found');

    let completedDetections = 0;


    const start = Date.now();
    let totalDetectors = 0;
    let clusterDps: number;
    await Promise.allSettled(availableObjectDetectors.map(async id => {
        const d = sdk.systemManager.getDeviceById<Settings & ObjectDetection & ClusterForkInterface>(id);
        if (!d) {
            console.log(`${id} not found, skipping.`);
            return;
        }

        console.log(`\nStarting ${id}`);
        console.log(`${id} Plugin Version:`, d.info?.version || 'Not found');

        const runClusterWorkerDetector = async (d: ObjectDetection & Settings) => {
            console.log('Settings:');
            try {
                const settings = await d.getSettings();
                for (const setting of settings) {
                    console.log(`  ${setting.title}: ${setting.value}`);
                }
            }
            catch (error) {
                console.log('  Unable to retrieve settings');
            }
            try {
                const completedDetectionsForRun = await runDetector({
                    batch,
                    batchesPerCamera,
                    d,
                    image,
                    simulatedCameras,
                    logProgress
                });
                completedDetections += completedDetectionsForRun;

                const end = Date.now();
                if (!clusterDps)
                    clusterDps = completedDetections / ((end - start) / 1000);

                const ms = end - start;
                console.log(`\n${id} benchmark complete:`);
                console.log(`Total time: ${ms} ms`);
                const detections = batchesPerCamera * simulatedCameras * batch;
                const detectionRate = (detections / (ms / 1000)).toFixed(2);
                console.log(`Total detections: ${detections}`);
                console.log(`Detection rate: ${detectionRate} detections per second`);
                totalDetectors++;

                detectorsStats.push({
                    name: id,
                    time: (ms / 1000).toFixed(2),
                    detections,
                    detectionRate
                });
            }
            catch (error) {
                console.log(`Error running benchmark for ${id}:`, error.message);
            }
        }

        if (!sdk.clusterManager?.getClusterMode?.()) {
            await runClusterWorkerDetector(d);
        }
        else {
            const workers = await sdk.clusterManager.getClusterWorkers();
            await Promise.allSettled(Object.values(workers).map(async worker => {
                if (!worker.labels.includes(id))
                    return;
                const forked = await d.forkInterface<ObjectDetection & Settings>(ScryptedInterface.ObjectDetection, {
                    clusterWorkerId: worker.id,
                });
                console.log('Running on cluster worker', worker.name);
                await runClusterWorkerDetector(forked);
            }));

        }
    }));

    let clusterDpsToReport;
    if (sdk.clusterManager?.getClusterMode?.()) {
        console.log(`\nCluster benchmark complete:`);
        console.log(`Detection rate: ${clusterDps.toFixed(2)} detections per second`);
        clusterDpsToReport = clusterDps.toFixed(2);
    }

    return {
        clusterDps: clusterDpsToReport,
        detectorsStats
    }
};

export const executeWorkerDetections = async (props: {
    workerName: string,
    detectionsToRun: number
}) => {
    const { detectionsToRun, workerName } = props;
    const workers = await getClusterWorkers();
    const worker = workers.find(item => item.name === workerName);

    if (!worker) {
        return null;
    } else {
        const detectorId = availableObjectDetectors.find(detector => worker.labels.includes(detector));

        const d = sdk.systemManager.getDeviceById<Settings & ObjectDetection & ClusterForkInterface>(detectorId);
        const forked = await d.forkInterface<ObjectDetection & Settings>(ScryptedInterface.ObjectDetection, {
            clusterWorkerId: worker.id,
        });
        const image = await getTestImage();

        const completedDetectionsForRun = await runDetector({
            batch: 1,
            batchesPerCamera: detectionsToRun,
            d: forked,
            image,
            simulatedCameras: 1,
        });

        return { detectorId, completedDetectionsForRun };
    }
}

export const getClusterWorkers = async () => {
    const clusterFork = await sdk.systemManager.getComponent('cluster-fork');
    if (clusterFork) {
        const clusterWorkers = await clusterFork.getClusterWorkers() as Record<string, ClusterWorker>;

        return Object.values(clusterWorkers);
    }
}

export const getWebooks = async () => {
    const healthcheck = 'healthcheck';

    return {
        healthcheck
    };
}

export const getWebHookUrls = async (props: {
    workerName?: string,
    console: Console,
}) => {
    const {
        console,
        workerName,
    } = props;

    let healthcheckUrl: string;

    const {
        healthcheck
    } = await getWebooks();

    try {
        const cloudEndpointRaw = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });

        const [cloudEndpoint, parameters] = cloudEndpointRaw.split('?') ?? '';
        const paramString = parameters ? `?${parameters}` : '';

        const encodedWorkerName = encodeURIComponent(workerName);

        healthcheckUrl = `${cloudEndpoint}${healthcheck}/${encodedWorkerName}${paramString}`;
    } catch (e) {
        console.log('Error fetching webhookUrls. Probably Cloud plugin is not setup correctly', e.message);
    }

    return {
        healthcheckUrl
    };
}