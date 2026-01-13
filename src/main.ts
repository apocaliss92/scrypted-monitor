import sdk, { HttpRequest, HttpRequestHandler, HttpResponse, Notifier, Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import moment from "moment";
import cron, { ScheduledTask } from 'node-cron';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import DiagnosticsPlugin from '../../scrypted/plugins/diagnostics/src/main';
import { scrypted } from '../package.json';
import { executeWorkerDetections, fetchPluginEvents, getAllPlugins, getClusterWorkers, getPluginStats, getRpcData, getTaskChecksum, getTaskKeys, getWebHookUrls, getWebooks, pluginHasUpdate, restartPlugin, restartScrypted, runValidate, ScryptedLogEntry, Task, TaskType, updatePlugin } from "./utils";
import { keyBy } from "lodash";

const divider = '-------------';

export default class RemoteBackup extends BasePlugin implements HttpRequestHandler {
    private cronTasks: ScheduledTask[] = [];
    private currentChecksum: string;
    private diagnosticsPlugin: any;
    private tasksCheckListener: NodeJS.Timeout;
    private lastWorkerHealthcheck: Record<string, number> = {};
    private pluginEventsMonitorInterval: NodeJS.Timeout;
    private pluginEventsMonitorRunning = false;
    private pluginEventsLastSeenByTaskPlugin = new Map<string, string>();
    storageSettings = new StorageSettings<string>(this, {
        ...getBaseSettings({
            onPluginSwitch: (_, enabled) => this.startStop(enabled),
            hideMqtt: true,
            hideHa: false,
        }),
        tasks: {
            title: 'Tasks',
            multiple: true,
            combobox: true,
            type: 'string',
            choices: [],
            defaultValue: [],
        },
        notifier: {
            title: 'Notifier',
            type: 'device',
            deviceFilter: `(type === '${ScryptedDeviceType.Notifier}')`,
        },
        datesLocale: {
            title: 'Dates locale',
            type: 'string',
            placeholder: 'en-US',
            defaultValue: 'en-US',
        },
        taskManualExecution: {
            title: 'Task to run',
            group: 'Manual execute',
            immediate: true,
            choices: [],
            onGet: async () => {
                return {
                    choices: this.storageSettings.values.tasks,
                }
            }
        },
        startManualExecution: {
            title: 'Execute',
            group: 'Manual execute',
            type: 'button',
            onPut: async () => {
                const { taskManualExecution } = this.storageSettings.values;
                if (taskManualExecution) {
                    await this.executeTask(this.getTask(taskManualExecution));
                }
            }
        },
        cameraMigrationSource: {
            title: 'Source camera',
            group: 'Camera migration',
            type: 'device',
            deviceFilter: `(type === '${ScryptedDeviceType.Camera}')`,
        },
        cameraMigrationTarget: {
            title: 'Target camera',
            group: 'Camera migration',
            type: 'device',
            deviceFilter: `(type === '${ScryptedDeviceType.Camera}')`,
        },
        cameraMigrationExecute: {
            title: 'Migrate',
            group: 'Camera migration',
            type: 'button',
            immediate: true,
            onPut: async () => {
                const logger = this.getLogger();
                const { cameraMigrationSource, cameraMigrationTarget } = this.storageSettings.values;

                if (!cameraMigrationSource || !cameraMigrationTarget) {
                    logger.log('Camera migration: source e target sono obbligatori');
                    return;
                }

                if (cameraMigrationSource === cameraMigrationTarget) {
                    logger.log('Camera migration: source e target devono essere diversi');
                    return;
                }

                await this.migrateCamera(cameraMigrationSource, cameraMigrationTarget);
            }
        },
        healthcheckEndpoints: {
            title: 'Healthcheck endpoints',
            group: 'Healthcheck Webhooks',
            type: 'string',
            multiple: true,
            defaultValue: [],
            hide: true,
            readonly: true,
        }
    });

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Monitor'
        });
        this.diagnosticsPlugin = new DiagnosticsPlugin();
        this.diagnosticsPlugin.lastMotionMaxHours = 16;
        this.diagnosticsPlugin.lastPressMaxHours = 16;

        this.start(true).then().catch(console.log);
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const logger = this.getLogger();
        const url = new URL(`http://localhost${request.url}`);

        const [_, __, ___, ____, _____, webhook, ...rest] = url.pathname.split('/');
        const [workerNameRaw] = rest
        let workerName = decodeURIComponent(workerNameRaw);
        logger.log(`Webhook request: ${JSON.stringify({
            url: request.url,
            body: request.body,
            webhook,
            workerNameRaw,
            workerName,
        })}`);

        try {
            const { healthcheck } = await getWebooks();
            if (webhook === healthcheck) {
                const lastRun = this.lastWorkerHealthcheck[workerName];

                const now = Date.now();
                const msFromLastRun = now - lastRun;
                if (!lastRun || (msFromLastRun) > 1000 * 30) {
                    const detectionsToRun = 5;
                    const detectionResult = await executeWorkerDetections({ workerName, detectionsToRun });
                    this.lastWorkerHealthcheck[workerName] = now;

                    if (detectionResult) {
                        if (detectionResult.completedDetectionsForRun === detectionsToRun) {
                            response.send('Ok', {
                                code: 200,
                            });
                        } else {
                            response.send('NotOk', {
                                code: 400,
                            });
                        }
                        return;
                    } else {
                        response.send(`Worker ${workerName} not found`, {
                            code: 404,
                        });
                        return;
                    }
                } else {
                    response.send(`Need to wait at least 30 seconds between healthchecks, ${30 - (msFromLastRun / 1000)} seconds remaining`, {
                        code: 500,
                    });
                    return;
                }
            } else {
                response.send(`Webohok ${webhook} not found`, {
                    code: 404,
                });
                return;
            }
        } catch (e) {
            logger.log('error in onRequest', e);

            response.send(`Error in healthcheck, ${e.message}`, {
                code: 500,
            });
            return;
        }
    }

    async start(shouldLog: boolean) {
        const logger = this.getLogger();
        if (shouldLog) {
            logger.log('Plugin enabled, starting');
        }

        if (sdk.clusterManager?.getClusterMode?.()) {
            const workers = await getClusterWorkers();
            const webhooks: string[] = [];

            for (const worker of workers) {
                const { healthcheckUrl } = await getWebHookUrls({ workerName: worker.name, console: logger });
                webhooks.push(healthcheckUrl);
            }
            logger.log(webhooks);

            this.storageSettings.settings.healthcheckEndpoints.hide = false;
            this.storageSettings.values.healthcheckEndpoints = webhooks;
        }

        this.tasksCheckListener = setInterval(async () => {
            await this.checkActiveTasks();
        }, 15000);

        await this.checkActiveTasks();
    }

    async stop(shouldLog: boolean) {
        if (shouldLog) {
            const logger = this.getLogger();
            logger.log('Plugin disabled, terminating');
        }

        this.tasksCheckListener && clearInterval(this.tasksCheckListener);
        if (this.pluginEventsMonitorInterval) {
            clearInterval(this.pluginEventsMonitorInterval);
            this.pluginEventsMonitorInterval = undefined;
            this.pluginEventsMonitorRunning = false;
        }
        this.cronTasks.forEach(task => task.stop());
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start(true);
        } else {
            await this.stop(true);
        }
    }

    getTask(taskName: string): Task {
        const {
            taskCronKey,
            taskDevicesKey,
            taskPluginsKey,
            taskTypeKey,
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
            taskPluginEventsLevelKey,
            taskRpcObjects,
        } = getTaskKeys(taskName);

        return {
            name: taskName,
            type: this.storage.getItem(taskTypeKey) as TaskType,
            cronScheduler: this.storage.getItem(taskCronKey),
            rebootOnErrors: JSON.parse(this.storage.getItem(taskRebootKey) ?? 'false'),
            skipNotify: JSON.parse(this.storage.getItem(taskSkipNotify) ?? 'false'),
            runSystemDiagnostic: JSON.parse(this.storage.getItem(taskSystemDiagnostic) ?? 'true'),
            beta: JSON.parse(this.storage.getItem(taskBetaKey) ?? 'false'),
            plugins: JSON.parse(this.storage.getItem(taskPluginsKey as any) as string ?? '[]'),
            pluginEventsLevel: (this.storage.getItem(taskPluginEventsLevelKey) as any) || 'warning',
            devices: JSON.parse(this.storage.getItem(taskDevicesKey as any) as string ?? '[]'),
            additionalNotifiers: JSON.parse(this.storage.getItem(taskAdditionalNotifiers as any) as string ?? '[]'),
            enabled: JSON.parse(this.storage.getItem(taskEnabledKey) ?? 'true'),
            checkAllPlugins: JSON.parse(this.storage.getItem(taskCheckAllPluginsVersion) ?? 'true'),
            maxStats: JSON.parse(this.storage.getItem(taskMaxStatsKey) ?? '5'),
            rpcThreshold: this.storage.getItem(taskRpcObjects) ? JSON.parse(this.storage.getItem(taskRpcObjects)) : '',
            entitiesToAlwaysReport: JSON.parse(this.storage.getItem(taskEntitiesToAlwaysReport as any) as string ?? '[]'),
            entitiesToExclude: JSON.parse(this.storage.getItem(taskEntitiesToExclude as any) as string ?? '[]'),
            batteryThreshold: JSON.parse(this.storage.getItem(taskBatteryThreshold) ?? '30'),
            unavailableTime: JSON.parse(this.storage.getItem(tasksUnavailableTime) ?? '24'),
            calendarDaysInFuture: JSON.parse(this.storage.getItem(taskCalendarDaysInFuture) ?? '14'),
            calendarEntity: this.storage.getItem(taskCalendarEntity as any) as string,
        };
    }

    async getTasks() {
        const { tasks = [] } = this.storageSettings.values;
        const taskEntities: Task[] = [];

        tasks.forEach((taskName: string) => {
            const task = this.getTask(taskName);
            if (task.enabled) {
                taskEntities.push(task);
            }
        });

        return taskEntities;
    }

    async executeTask(task: Task) {
        const logger = this.getLogger();
        const {
            name,
            rebootOnErrors,
            type,
            devices,
            plugins,
            rpcThreshold,
            runSystemDiagnostic,
            beta,
            maxStats,
            skipNotify,
            checkAllPlugins,
            batteryThreshold,
            entitiesToAlwaysReport,
            entitiesToExclude,
            additionalNotifiers,
            calendarEntity,
            calendarDaysInFuture,
            pluginEventsLevel,
        } = task;
        const { datesLocale } = this.storageSettings.values;

        let message = ``;
        const title = `${name}`;
        let priority;
        let forceStop;

        let actionsToDefer: () => Promise<void>;

        if (type === TaskType.Diagnostics) {
            for (const deviceId of devices) {
                const device = sdk.systemManager.getDeviceById(deviceId) as unknown as ScryptedDeviceBase & Reboot;
                logger.log(`Starting ${type} for ${device.name}`);
                const result = await runValidate(this.diagnosticsPlugin, logger, deviceId);
                logger.log(`Result for ${type}-${name}: ${JSON.stringify(result)}`);
                message += `[${device.name}]: ${result.text}`;

                if (rebootOnErrors && result.errorSteps.length > 0 && device.interfaces.includes(ScryptedInterface.Reboot)) {
                    message += ` | Restarting |`;
                    logger.log(`Restarting ${device.name}`);
                    await device.reboot();
                }

                message += `\n`;
            }

            if (runSystemDiagnostic) {
                logger.log(`Starting ${type} for System`);
                const result = await runValidate(this.diagnosticsPlugin, logger);
                logger.log(`Result for ${type}-System: ${JSON.stringify(result)}`);
                message += `[System]: ${result.text}`
            }
        } else if (type === TaskType.RestartPlugins) {
            const threshold = Number(rpcThreshold || 0);
            if (threshold > 0) {
                logger.log(`Skipping ${type} execution because rpcThreshold is set (${threshold}). This task runs via 10s interval.`);
                forceStop = true;
            } else {
                let shouldSelfRestart = false;
                for (const pluginId of plugins) {
                    const plugin = sdk.systemManager.getDeviceById(pluginId);
                    const packageName = plugin.info.manufacturer;
                    logger.log(`Restarting plugin ${packageName}`);

                    if ([scrypted.name, '@scrypted/core'].includes(packageName)) {
                        shouldSelfRestart = true;
                    } else {
                        await restartPlugin(packageName);
                    }
                    message += `[${packageName}]: Restarted\n`;
                }

                if (shouldSelfRestart) {
                    actionsToDefer = async () => {
                        await restartPlugin(scrypted.name);
                    }
                }
            }
        } else if (type === TaskType.PluginEventsMonitoring) {
            const selectedPlugins = plugins?.length ? plugins : getAllPlugins();

            message += `[Plugins]\n`;
            selectedPlugins.forEach(p => message += `${p}\n`);
            message += `${divider}\n`;

            const normalizeLevel = (level: string | undefined) => (level || '').toLowerCase();
            const levelRank = (level: string | undefined) => {
                const l = normalizeLevel(level);
                if (l === 'e' || l.includes('err') || l.includes('error') || l.includes('fatal'))
                    return 2;
                if (l === 'w' || l.includes('warn'))
                    return 1;
                return 0;
            };

            const thresholdRank = (() => {
                const t = (pluginEventsLevel || 'warning').toLowerCase();
                if (t === 'error') return 2;
                if (t === 'warning') return 1;
                return 0;
            })();

            let anyFindings = false;
            for (const pluginName of selectedPlugins) {
                let logs = [] as Awaited<ReturnType<typeof fetchPluginEvents>>;
                try {
                    logs = await fetchPluginEvents(pluginName);
                } catch (e) {
                    const err = e as any;
                    anyFindings = true;
                    message += `[${pluginName}]: error fetching logs: ${err?.message || err}\n`;
                    continue;
                }

                const sample = logs.slice(0, 50);
                const selected = sample.filter(l => levelRank(l.level) >= thresholdRank);
                if (!selected.length) {
                    continue;
                }

                const warnCount = selected.filter(l => levelRank(l.level) === 1).length;
                const errorCount = selected.filter(l => levelRank(l.level) === 2).length;
                const infoCount = selected.filter(l => levelRank(l.level) === 0).length;

                anyFindings = true;
                message += `[${pluginName}]: errors=${errorCount}, warnings=${warnCount}, info=${infoCount} (threshold=${pluginEventsLevel || 'warning'})\n`;

                const top = selected.slice(0, 3);
                for (const entry of top) {
                    const ts = new Date(entry.timestamp).toLocaleString(datesLocale || 'en-US');
                    message += `  - ${ts}: ${entry.message}\n`;
                }
            }

            if (!anyFindings) {
                forceStop = true;
            }
        } else if (type === TaskType.UpdatePlugins) {
            const finalizeVersion = (isBeta: boolean) => {
                if (isBeta) {
                    message += ` (beta)`;
                }
                message += `\n`;
            }

            const allPlugins = getAllPlugins().map(pluginName => {
                return sdk.systemManager.getDeviceByName(pluginName);
            });

            const isAllPlugins = !plugins?.length;
            const pluginsToUpdate = isAllPlugins ? allPlugins.map(plugin => plugin.id) : plugins;
            let somePluginUpdated = false;
            for (const pluginId of pluginsToUpdate) {
                const plugin = sdk.systemManager.getDeviceById(pluginId);
                const { manufacturer, version } = plugin.info;

                logger.log(`Updating plugin ${manufacturer}`);
                const updateResult = await updatePlugin(logger, manufacturer, version, beta);

                if (updateResult) {
                    const { newVersion, isBeta } = updateResult;
                    if (newVersion) {
                        message += `[${manufacturer}]: Updated ${version} -> ${newVersion}`;
                        finalizeVersion(isBeta);
                        somePluginUpdated = true;
                    }
                    //  else if (!isAllPlugins) {
                    //     const versionEntry = versions.find(item => item.version === version);
                    //     message += `[${manufacturer}]: Already on latest version ${version}`;
                    //     finalizeVersion(versionEntry?.tag === 'beta');
                    // }
                }
            }

            let somePluginOutdated = false;
            if (checkAllPlugins && !isAllPlugins) {
                const otherPlugins = allPlugins.filter(plugin => !plugins.includes(plugin.id));
                logger.log(`Checking other plugins: ${otherPlugins.map(plugin => plugin.name)}`);

                for (const plugin of otherPlugins) {
                    const { manufacturer, version } = plugin.info;
                    const { newVersion, isBeta } = await pluginHasUpdate(logger, manufacturer, version, beta);
                    if (newVersion) {
                        somePluginOutdated = true;
                        message += `[${manufacturer}]: New version available ${newVersion}`;
                        finalizeVersion(isBeta);
                    }
                }

                // if (!somePluginOutdated) {
                //     message += `\nAll the other plugins are on the latest version\n`;
                // }
            }

            if (!somePluginUpdated && !somePluginOutdated) {
                forceStop = true;
            }
        } else if (type === TaskType.ReportPluginsStatus) {
            const stats = await getPluginStats(maxStats);

            logger.log(`Current stats: ${JSON.stringify(stats)}`);

            if (stats.benchmark) {
                message += `[Benchmark]\n`;
                stats.benchmark.detectorsStats.forEach(item => message += `${item.name}: ${item.detections} detections in ${item.time} seconds (${item.detectionRate} dps)\n`);
                if (stats.benchmark.clusterDps != null) {
                    message += `Cluster detections per second: ${stats.benchmark.clusterDps}\n`;
                }
                message += `${divider}\n`;
            }

            if (stats.currentObjectDetections || stats.currentActiveStreams != null) {
                message += `[General]\n`;

                if (stats.currentObjectDetections) {
                    message += `Active object detection sessions: ${stats.currentObjectDetections.length}\n`;
                    message += `Active motion detection sessions: ${stats.currentMotionDetections.length}\n`;
                }

                if (stats.currentActiveStreams != null) {
                    message += `Active stream sessions: ${stats.currentActiveStreams}\n`;
                }

                message += `Storage usage: ${stats.freeSpace}\n`;
                message += `Recording cameras: ${stats.recordingCameras}\n`;

                message += `${divider}\n`;
            }


            if (stats.rpcObjects) {
                message += `[RPC Objects]\n`;
                stats.rpcObjects.forEach(item => message += `${item.name}: ${item.count}\n`);
                message += `${divider}\n`;
            }

            if (stats.pendingResults) {
                message += `[Pending Results]\n`;
                stats.pendingResults.forEach(item => message += `${item.name}: ${item.count}\n`);
                message += `${divider}\n`;
            }

            if (stats.connections.length) {
                message += `[Connections]\n`;
                stats.connections.forEach(item => message += `${item.name}: ${item.count}\n`);
                message += `${divider}\n`;
            }

            if (stats.cluster) {
                message += `[Workers]\n`;
                stats.cluster.workers.forEach(item => message += `${item.name}: ${item.count}\n`);
                message += `${divider}\n`;

                message += `[Devices]\n`;
                stats.cluster.devices.forEach(item => message += `${item.name}: ${item.count}\n`);
            }
        } else if (type === TaskType.RestartCameras) {
            logger.log(`Restarting cameras: ${JSON.stringify(devices)}`);
            for (const deviceId of devices) {
                const device = sdk.systemManager.getDeviceById(deviceId) as unknown as ScryptedDeviceBase & Reboot;
                message += `[${device.name}] Restarted\n`;
                await device.reboot();
            }
        } else if (type === TaskType.ReportHaBatteryStatus) {
            logger.log(`Reporting HA battery statuses`);
            const haApi = await this.getHaApi();
            const statuses = await haApi.getStatesData();
            let atLeast1LowBattery = false;
            const trackedEntries: string[] = [];

            statuses.data.forEach(entity => {
                if (!entitiesToExclude.includes(entity.entity_id) && entity.attributes.device_class === 'battery') {
                    if (entity.entity_id.startsWith('sensor.')) {
                        const batteryPerc = Number(entity.state ?? -1);
                        if (batteryPerc < 10) {
                            priority = 1;
                        }

                        const messageToAdd = `${entity?.attributes?.friendly_name} (${entity.state}%)`;
                        if (entitiesToAlwaysReport.includes(entity.entity_id)) {
                            trackedEntries.push(messageToAdd);
                        } else if (batteryPerc < batteryThreshold) {
                            message += `${messageToAdd}\n`;
                            atLeast1LowBattery = true;
                        }
                    } else if (entity.entity_id.startsWith('binary_sensor.')) {
                        const messageToAdd = `${entity?.attributes?.friendly_name}`;
                        if (entitiesToAlwaysReport.includes(entity.entity_id)) {
                            trackedEntries.push(messageToAdd);
                        } else if (entity.state === 'on') {
                            priority = 1;
                            message += `${messageToAdd}\n`;
                            atLeast1LowBattery = true;
                        }
                    }
                }
            });

            if (trackedEntries.length) {
                if (atLeast1LowBattery) {
                    message += `${divider}\n`;
                }

                for (const trackedEntry of trackedEntries) {
                    message += `${trackedEntry}\n`
                }
            }

            if (!atLeast1LowBattery && !trackedEntries.length) {
                message += `All batteries ok\n`;
            }
        } else if (type === TaskType.ReportHaUnavailableEntities) {
            logger.log(`Reporting HA unavailable sensors`);
            const haApi = await this.getHaApi();
            const statuses = await haApi.getStatesData();
            let atLeast1Unavailable = false;

            statuses.data.forEach(entity => {
                if (
                    entity.state === 'unavailable' &&
                    (entitiesToAlwaysReport?.length ?
                        entitiesToAlwaysReport.some(regex => new RegExp(regex).test(entity.entity_id)) :
                        true
                    ) &&
                    (entitiesToExclude?.length ?
                        entitiesToExclude.every(regex => !(new RegExp(regex).test(entity.entity_id))) :
                        true
                    )
                ) {
                    const lastUpdate = entity.attributes.last_seen ?? entity.last_reported;
                    let messageToAdd = `${entity?.attributes?.friendly_name}`;
                    if (lastUpdate) {
                        const timeString = moment(lastUpdate).locale(datesLocale).calendar();
                        messageToAdd += `: ${timeString}`;
                    }
                    message += `${messageToAdd}\n`;
                    atLeast1Unavailable = true;
                }
            });

            if (!atLeast1Unavailable) {
                forceStop = true;
            }
        } else if (type === TaskType.ReportHaConsumables) {
            logger.log(`Reporting HA consumables`);
            const haApi = await this.getHaApi();
            const statuses = await haApi.getStatesData();
            let atLeast1Problem = false;

            statuses.data.forEach(entity => {
                if (entitiesToAlwaysReport.includes(entity.entity_id)) {
                    if (entity.attributes.unit_of_measurement === '%') {
                        if (Number(entity.state) < 10) {
                            message += `${entity.attributes.friendly_name}: ${entity.state} %\n`;
                            atLeast1Problem = true;
                        }
                    } else if (entity.attributes.unit_of_measurement === 'd') {
                        if (Number(entity.state) <= 3) {
                            message += `${entity.attributes.friendly_name}: ${entity.state} days\n`;
                            atLeast1Problem = true;
                        }
                    } else if (entity.attributes.device_class === 'problem') {
                        if (entity.state === 'on') {
                            message += `${entity.attributes.friendly_name}\n`;
                            atLeast1Problem = true;
                        }
                    }
                }
            });

            if (!atLeast1Problem) {
                forceStop = true;
            } else {
                priority = 1;
            }
        } else if (type === TaskType.TomorrowEventsHa) {
            logger.log(`Reporting tomorrow HA calendar events`);
            const haApi = await this.getHaApi();
            const fromDate = moment().add(1, 'days').startOf('day').toISOString().replace('T', ' ').split('.')[0];
            const endDate = moment().add(1, 'days').endOf('day').toISOString().replace('T', ' ').split('.')[0];
            const endDateFuture = moment().add(calendarDaysInFuture, 'days').endOf('day').toISOString().replace('T', ' ').split('.')[0];
            const eventsResponse = await haApi.getCalendarEvents(
                calendarEntity,
                fromDate,
                endDate,
            );
            const eventsResponseFuture = await haApi.getCalendarEvents(
                calendarEntity,
                endDate,
                endDateFuture,
            );
            const events = eventsResponse.data.service_response[calendarEntity]?.events;
            logger.log(`Events found: ${events}`);

            for (const event of events) {
                priority = 1;
                const startDate = new Date(event.start);
                if (event.start.length === 10) {
                    message += `${event.summary} - ${moment(startDate).locale(datesLocale).fromNow()}\n`;
                } else {
                    message += `${event.summary} - ${moment(startDate).locale(datesLocale).calendar()}\n`;
                }
            }

            const eventsFuture = eventsResponseFuture.data.service_response[calendarEntity]?.events;
            logger.log(`Events found in the next ${calendarDaysInFuture} days: ${eventsFuture}`)

            if (eventsFuture.length) {
                if (events.length) {
                    message += `${divider}\n`;
                }

                for (const event of eventsFuture) {
                    const startDate = new Date(event.start);
                    if (event.start.length === 10) {
                        message += `${event.summary} - ${moment(startDate).locale(datesLocale).fromNow()}\n`;
                    } else {
                        message += `${event.summary} - ${moment(startDate).locale(datesLocale).calendar()}\n`;
                    }
                }
            }

            if (!events.length && !eventsFuture.length) {
                forceStop = true;
            }

            if (events.length) {
                priority = 1;
            }
        } else if (type === TaskType.RestartScrypted) {
            logger.log(`Restarting scrypted`);

            message += `Scrypted restarted`;

            actionsToDefer = async () => {
                await restartScrypted();
            }
        }

        if (!skipNotify && !forceStop) {
            const { notifier } = this.storageSettings.values;
            const notifiers: (ScryptedDeviceBase & Notifier)[] = [];
            if (additionalNotifiers?.length) {
                for (const notifierId of additionalNotifiers) {
                    notifiers.push(sdk.systemManager.getDeviceById(notifierId) as unknown as (ScryptedDeviceBase & Notifier));
                }
            } else if (notifier) {
                notifiers.push(notifier);
            }

            for (const notifierDevice of notifiers) {
                logger.log(`Sending notification to ${notifierDevice.name}: ${JSON.stringify({ title, message })}`);
                await notifierDevice.sendNotification(title, {
                    body: message,
                    data: {
                        pushover: {
                            priority
                        }
                    }
                });
            }
        } else {
            logger.log(`Skipping notification`);
        }

        if (actionsToDefer) {
            await actionsToDefer();
        }
    }

    getLogger() {
        return super.getLoggerInternal({});
    }

    private async migrateCamera(sourceDeviceId: string, targetDeviceId: string) {
        const logger = this.getLogger();
        const source = sdk.systemManager.getDeviceById<Settings>(sourceDeviceId);
        const target = sdk.systemManager.getDeviceById<Settings>(targetDeviceId);

        if (!source || !target) {
            throw new Error('Camera migration: source o target non trovato');
        }

        logger.log(`Camera migration: ${source.name} (${sourceDeviceId}) -> ${target.name} (${targetDeviceId})`);

        const [sourceSettings, targetSettings] = await Promise.all([
            source.getSettings(),
            target.getSettings(),
        ]);

        const targetSettingsByKey = keyBy(targetSettings, 'key');
        let migratedCount = 0;

        for (const setting of sourceSettings) {
            const { key } = setting;

            if (!targetSettingsByKey[key]) {
                continue;
            }

            const group = key.split(':')[0];

            if (['objectdetectionplugin'].includes(group)) {
                await target.putSetting(key, setting.value);
            }

        }

        logger.log(`Camera migration: completata (settings copiati: ${migratedCount})`);
    }

    async startTaskCron(task: Task) {
        const logger = this.getLogger();
        try {
            const {
                cronScheduler,
                name,
                type,
                rpcThreshold,
            } = task;

            if (type === TaskType.PluginEventsMonitoring) {
                return;
            }

            if (type === TaskType.RestartPlugins && Number(rpcThreshold || 0) > 0) {
                return;
            }
            if (cronScheduler) {
                logger.log(`Starting scheduler ${name} with cron ${cronScheduler} `);
                const newTask = cron.schedule(cronScheduler, async () => {
                    await this.executeTask(task);
                });

                this.cronTasks.push(newTask);
            }
        } catch (e) {
            logger.log('Error executing task', task, e);
        }
    }

    async checkActiveTasks() {
        const logger = this.getLogger();
        const taskEntities = await this.getTasks();

        this.updatePluginEventsMonitoringInterval(taskEntities);

        const newCronChecksum = JSON.stringify(taskEntities.map(getTaskChecksum));
        if (newCronChecksum !== this.currentChecksum) {
            this.currentChecksum = newCronChecksum;
            logger.log('Tasks updated, restarting');
            this.cronTasks.forEach(task => task.stop());

            for (const task of taskEntities) {
                await this.startTaskCron(task);
            }
        }
    }

    private updatePluginEventsMonitoringInterval(taskEntities: Task[]) {
        const logger = this.getLogger();
        const enabledTaskEntities = taskEntities.filter(task => task.enabled);
        const shouldRun = enabledTaskEntities.some(task =>
            (task.type === TaskType.PluginEventsMonitoring && !!task.plugins?.length)
            || (task.type === TaskType.RestartPlugins && Number(task.rpcThreshold || 0) > 0 && !!task.plugins?.length)
        );

        if (!shouldRun) {
            if (this.pluginEventsMonitorInterval) {
                clearInterval(this.pluginEventsMonitorInterval);
                this.pluginEventsMonitorInterval = undefined;
                this.pluginEventsMonitorRunning = false;
                logger.log('PluginEventsMonitoring: interval stopped');
            }
            return;
        }

        if (this.pluginEventsMonitorInterval) {
            return;
        }

        logger.log('PluginEventsMonitoring: interval started (10s)');
        this.pluginEventsMonitorInterval = setInterval(() => {
            this.pluginEventsMonitorTick().catch(e => logger.log('PluginEventsMonitoring tick error', e));
        }, 10_000);

        this.pluginEventsMonitorTick().catch(e => logger.log('PluginEventsMonitoring tick error', e));
    }

    private async pluginEventsMonitorTick() {
        if (this.pluginEventsMonitorRunning) {
            return;
        }

        this.pluginEventsMonitorRunning = true;
        const logger = this.getLogger();
        try {
            const taskEntities = await this.getTasks();
            const pluginEventTasks = taskEntities.filter(task =>
                task.type === TaskType.PluginEventsMonitoring
                && !!task.plugins?.length
                && task.enabled
            );

            const restartRpcTasks = taskEntities.filter(task =>
                task.type === TaskType.RestartPlugins
                && Number(task.rpcThreshold || 0) > 0
                && !!task.plugins?.length
                && task.enabled
            );

            if (!pluginEventTasks.length && !restartRpcTasks.length) {
                return;
            }

            const { datesLocale, notifier } = this.storageSettings.values;

            const normalizeLevel = (level: string | undefined) => (level || '').toLowerCase();
            const levelRank = (level: string | undefined) => {
                const l = normalizeLevel(level);
                if (l === 'e' || l.includes('err') || l.includes('error') || l.includes('fatal'))
                    return 2;
                if (l === 'w' || l.includes('warn'))
                    return 1;
                return 0;
            };

            const thresholdRankForTask = (task: Task) => {
                const t = (task.pluginEventsLevel || 'warning').toLowerCase();
                if (t === 'error') return 2;
                if (t === 'warning') return 1;
                return 0;
            };

            const signature = (entry: Awaited<ReturnType<typeof fetchPluginEvents>>[number]) => {
                return `${entry.timestamp}_${entry.level}`;
            };

            for (const task of pluginEventTasks) {
                const thresholdRank = thresholdRankForTask(task);
                const pendingLastSeenUpdates = new Map<string, string>();

                const lines: string[] = [];
                const plugins = task.plugins || [];

                for (const pluginName of plugins) {
                    let logs: ScryptedLogEntry[];
                    try {
                        logs = await fetchPluginEvents(pluginName);
                    } catch (e) {
                        const err = e as any;
                        lines.push(`[${pluginName}]: error fetching logs: ${err?.message || err}`);
                        continue;
                    }

                    if (!logs?.length) {
                        continue;
                    }

                    const newestSignature = signature(logs[0]);
                    const taskPluginKey = `${task.name}:${pluginName}`;
                    const lastSeen = this.pluginEventsLastSeenByTaskPlugin.get(taskPluginKey);

                    // First observation: initialize cursor, avoid spamming historical logs.
                    if (!lastSeen) {
                        pendingLastSeenUpdates.set(taskPluginKey, newestSignature);
                        continue;
                    }

                    const idx = logs.findIndex(l => signature(l) === lastSeen);
                    const unread = idx >= 0 ? logs.slice(0, idx) : logs.slice(0, 50);
                    const unreadMatchingThreshold = unread.filter(l => levelRank(l.level) >= thresholdRank);

                    // Always advance cursor to the newest log we saw for this plugin.
                    pendingLastSeenUpdates.set(taskPluginKey, newestSignature);

                    if (!unreadMatchingThreshold.length) {
                        continue;
                    }

                    const ordered = unreadMatchingThreshold.slice().reverse();
                    lines.push(`[${pluginName}] (${task.pluginEventsLevel || 'warning'})`);
                    for (const entry of ordered) {
                        const ts = new Date(entry.timestamp).toLocaleString(datesLocale || 'en-US');
                        lines.push(`- ${ts} [${entry.level}]: ${entry.message}`);
                    }
                }

                // If no notifier is configured (and no overrides), still advance cursors.
                if (!lines.length || task.skipNotify) {
                    for (const [k, v] of pendingLastSeenUpdates.entries()) {
                        this.pluginEventsLastSeenByTaskPlugin.set(k, v);
                    }
                    continue;
                }

                const notifiers: (ScryptedDeviceBase & Notifier)[] = [];
                if (task.additionalNotifiers?.length) {
                    for (const notifierId of task.additionalNotifiers) {
                        const device = sdk.systemManager.getDeviceById(notifierId) as unknown as (ScryptedDeviceBase & Notifier);
                        if (device) {
                            notifiers.push(device);
                        }
                    }
                } else if (notifier) {
                    notifiers.push(notifier as any);
                }

                if (!notifiers.length) {
                    for (const [k, v] of pendingLastSeenUpdates.entries()) {
                        this.pluginEventsLastSeenByTaskPlugin.set(k, v);
                    }
                    continue;
                }

                const chunkSize = 80;
                const chunks: string[] = [];
                for (let i = 0; i < lines.length; i += chunkSize) {
                    chunks.push(lines.slice(i, i + chunkSize).join('\n'));
                }

                for (const notifierDevice of notifiers) {
                    for (let i = 0; i < chunks.length; i++) {
                        const title = chunks.length === 1 ? `${task.name}` : `${task.name} (${i + 1}/${chunks.length})`;
                        logger.log(`PluginEventsMonitoring notify ${notifierDevice.name}: ${JSON.stringify({ title })}`);
                        await notifierDevice.sendNotification(title, {
                            body: chunks[i],
                        });
                    }
                }

                for (const [k, v] of pendingLastSeenUpdates.entries()) {
                    this.pluginEventsLastSeenByTaskPlugin.set(k, v);
                }
            }

            if (restartRpcTasks.length) {
                const rpcData = await getRpcData();
                const statsByManufacturer = rpcData?.stats || {};

                for (const task of restartRpcTasks) {
                    const threshold = Number(task.rpcThreshold || 0);
                    if (!threshold) {
                        continue;
                    }

                    const plugins = task.plugins || [];
                    const lines: string[] = [];
                    let shouldSelfRestart = false;

                    for (const pluginId of plugins) {
                        const plugin = sdk.systemManager.getDeviceById(pluginId);
                        if (!plugin) {
                            continue;
                        }

                        const manufacturer = plugin.info?.manufacturer;
                        const info = manufacturer ? statsByManufacturer[manufacturer] : undefined;
                        const rpcObjects = info?.rpcObjects;

                        if (rpcObjects == null) {
                            continue;
                        }

                        if (rpcObjects > threshold) {
                            lines.push(`[${manufacturer}] rpcObjects=${rpcObjects} > ${threshold} -> restarting`);
                            if ([scrypted.name, '@scrypted/core'].includes(manufacturer)) {
                                shouldSelfRestart = true;
                            } else {
                                await restartPlugin(manufacturer);
                            }
                        }
                    }

                    if (!lines.length) {
                        continue;
                    }

                    if (task.skipNotify) {
                        if (shouldSelfRestart) {
                            await restartPlugin(scrypted.name);
                        }
                        continue;
                    }

                    const notifiers: (ScryptedDeviceBase & Notifier)[] = [];
                    if (task.additionalNotifiers?.length) {
                        for (const notifierId of task.additionalNotifiers) {
                            const device = sdk.systemManager.getDeviceById(notifierId) as unknown as (ScryptedDeviceBase & Notifier);
                            if (device) {
                                notifiers.push(device);
                            }
                        }
                    } else if (notifier) {
                        notifiers.push(notifier as any);
                    }

                    if (!notifiers.length) {
                        if (shouldSelfRestart) {
                            await restartPlugin(scrypted.name);
                        }
                        continue;
                    }

                    const chunkSize = 50;
                    const chunks: string[] = [];
                    for (let i = 0; i < lines.length; i += chunkSize) {
                        chunks.push(lines.slice(i, i + chunkSize).join('\n'));
                    }

                    for (const notifierDevice of notifiers) {
                        for (let i = 0; i < chunks.length; i++) {
                            const title = chunks.length === 1 ? `${task.name}` : `${task.name} (${i + 1}/${chunks.length})`;
                            logger.log(`RestartPlugins (rpcThreshold) notify ${notifierDevice.name}: ${JSON.stringify({ title })}`);
                            await notifierDevice.sendNotification(title, {
                                body: chunks[i],
                            });
                        }
                    }

                    if (shouldSelfRestart) {
                        await restartPlugin(scrypted.name);
                    }
                }
            }
        } finally {
            this.pluginEventsMonitorRunning = false;
        }
    }

    async getSettings() {
        const { tasks } = this.storageSettings.values;
        const settings: Setting[] = await super.getSettings();

        (tasks as string[]).forEach(task => {
            const {
                beta,
                cronScheduler,
                enabled,
                rebootOnErrors,
                skipNotify,
                type,
                devices,
                maxStats,
                plugins,
                runSystemDiagnostic,
                checkAllPlugins,
                batteryThreshold,
                entitiesToAlwaysReport,
                entitiesToExclude,
                additionalNotifiers,
                calendarEntity,
                calendarDaysInFuture,
                rpcThreshold
            } = this.getTask(task);
            const {
                taskCronKey,
                taskDevicesKey,
                taskPluginsKey,
                taskTypeKey,
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
                taskCalendarDaysInFuture,
                taskPluginEventsLevelKey,
                taskRpcObjects,
            } = getTaskKeys(task);
            const group = `Task: ${task}`;

            const exludedEntitiesSetting: Setting = {
                key: taskEntitiesToExclude,
                title: 'Entities to exclude',
                group,
                type: 'string',
                value: entitiesToExclude,
                multiple: true,
                combobox: true,
                choices: [],
            };
            const entitiesToAlwaysReportSetting: Setting = {
                key: taskEntitiesToAlwaysReport,
                title: 'Entities to always report',
                group,
                type: 'string',
                value: entitiesToAlwaysReport,
                multiple: true,
                combobox: true,
                choices: [],
            }

            settings.push(
                {
                    key: taskEnabledKey,
                    title: 'Enabled',
                    group,
                    type: 'boolean',
                    value: enabled,
                    immediate: true,
                },
                {
                    key: taskSkipNotify,
                    title: 'Skip notification',
                    group,
                    type: 'boolean',
                    value: skipNotify,
                    immediate: true,
                },
                {
                    key: taskTypeKey,
                    title: 'Task type',
                    type: 'string',
                    choices: Object.keys(TaskType),
                    value: type,
                    group,
                    immediate: true
                }
            );

            if ((type !== TaskType.RestartPlugins || !rpcThreshold) && type !== TaskType.PluginEventsMonitoring) {
                settings.push(
                    {
                        key: taskCronKey,
                        title: 'Cron',
                        description: 'Cron string',
                        type: 'string',
                        value: cronScheduler,
                        placeholder: '0 */6 * * *',
                        group,
                    });
            }

            if (!skipNotify) {
                settings.push({
                    key: taskAdditionalNotifiers,
                    title: 'Override notifiers',
                    type: 'device',
                    deviceFilter: `(type === '${ScryptedDeviceType.Notifier}')`,
                    multiple: true,
                    combobox: true,
                    value: additionalNotifiers,
                    group,
                });
            }

            if (type === TaskType.RestartPlugins) {
                settings.push(
                    {
                        key: taskRpcObjects,
                        title: 'RPC objects threshold',
                        group,
                        type: 'number',
                        value: rpcThreshold,
                    },
                    {
                        key: taskPluginsKey,
                        title: 'Plugins',
                        group,
                        type: 'device',
                        value: plugins,
                        deviceFilter: `(interfaces.includes('${ScryptedInterface.ScryptedPlugin}'))`,
                        multiple: true,
                        combobox: true,
                    }
                );
            }

            if (type === TaskType.PluginEventsMonitoring) {
                settings.push(
                    {
                        key: taskPluginsKey,
                        title: 'Plugins',
                        description: 'Leave empty to monitor all plugins',
                        group,
                        type: 'string',
                        value: plugins,
                        multiple: true,
                        combobox: true,
                        choices: getAllPlugins(),
                    }
                );

                settings.push(
                    {
                        key: taskPluginEventsLevelKey,
                        title: 'Level',
                        group,
                        type: 'string',
                        value: (this.getTask(task).pluginEventsLevel as any) || 'warning',
                        choices: ['info', 'warning', 'error'],
                        immediate: true,
                    }
                );
            }

            if (type === TaskType.UpdatePlugins) {
                settings.push(
                    {
                        key: taskPluginsKey,
                        title: 'Plugins',
                        description: 'Leave empty to update all the plugins',
                        group,
                        type: 'device',
                        value: plugins,
                        deviceFilter: `(interfaces.includes('${ScryptedInterface.ScryptedPlugin}'))`,
                        multiple: true,
                        combobox: true,
                    },
                    {
                        key: taskBetaKey,
                        title: 'Use Beta versions',
                        group,
                        type: 'boolean',
                        value: beta,
                        immediate: true,
                    },
                    {
                        key: taskCheckAllPluginsVersion,
                        title: 'Check other plugins',
                        group,
                        type: 'boolean',
                        value: checkAllPlugins,
                        immediate: true,
                    },
                );
            }

            if (type === TaskType.RestartCameras) {
                settings.push(
                    {
                        key: taskDevicesKey,
                        title: 'Cameras',
                        group,
                        type: 'device',
                        value: devices,
                        deviceFilter: `type === '${ScryptedDeviceType.Camera}' || type === '${ScryptedDeviceType.Doorbell}'`,
                        immediate: true,
                        multiple: true,
                        combobox: true,
                    }
                );
            }

            if (type === TaskType.Diagnostics) {
                settings.push(
                    {
                        key: taskDevicesKey,
                        title: 'Devices',
                        group,
                        type: 'device',
                        value: devices,
                        deviceFilter: `type === '${ScryptedDeviceType.Camera}' || type === '${ScryptedDeviceType.Doorbell}'  || type === '${ScryptedDeviceType.Notifier}'`,
                        immediate: true,
                        multiple: true,
                        combobox: true,
                    },
                    {
                        key: taskSystemDiagnostic,
                        title: 'Execute system diagnostic',
                        group,
                        type: 'boolean',
                        value: runSystemDiagnostic,
                        immediate: true,
                    },
                    {
                        key: taskRebootKey,
                        title: 'Reboot cameras on errors',
                        group,
                        type: 'boolean',
                        value: rebootOnErrors,
                        immediate: true,
                    },
                );
            }

            if (type === TaskType.ReportPluginsStatus) {
                settings.push(
                    {
                        key: taskMaxStatsKey,
                        title: 'Max elements to report',
                        group,
                        type: 'number',
                        value: maxStats,
                    }
                );
            }

            if (type === TaskType.ReportHaBatteryStatus) {
                settings.push(
                    {
                        key: taskBatteryThreshold,
                        title: 'Battery threshold',
                        group,
                        type: 'number',
                        value: batteryThreshold,
                    },
                    entitiesToAlwaysReportSetting,
                    exludedEntitiesSetting
                );
            }

            if (type === TaskType.ReportHaUnavailableEntities) {
                settings.push(
                    {
                        ...entitiesToAlwaysReportSetting,
                        title: 'Entities regexes to match',
                    },
                    // {
                    //     key: tasksUnavailableTime,
                    //     title: 'Hours to consider an entity offline',
                    //     group,
                    //     type: 'number',
                    //     value: unavailableTime,
                    // },
                    {
                        ...exludedEntitiesSetting,
                        title: 'Entities regexes to exclude',
                    },
                );
            }

            if (type === TaskType.ReportHaConsumables) {
                settings.push(
                    {
                        key: taskBatteryThreshold,
                        title: 'Threshold (%)',
                        group,
                        type: 'number',
                        value: batteryThreshold,
                    },
                    entitiesToAlwaysReportSetting,
                );
            }

            if (type === TaskType.TomorrowEventsHa) {
                settings.push(
                    {
                        key: taskCalendarEntity,
                        title: 'Calendar entity to report',
                        group,
                        type: 'string',
                        value: calendarEntity,
                    },
                    {
                        key: taskCalendarDaysInFuture,
                        title: 'Days in future to report ',
                        group,
                        type: 'number',
                        value: calendarDaysInFuture,
                    },
                );
            }
        });

        return settings;
    }
}
