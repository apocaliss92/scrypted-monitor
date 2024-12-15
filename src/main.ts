import sdk, { Notifier, Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import cron, { ScheduledTask } from 'node-cron';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getAllPlugins, getPluginStats, getTaskChecksum, getTaskKeys, pluginHasUpdate, restartScrypted, restartPlugin, runValidate, Task, TaskType, updatePlugin } from "./utils";
import moment from "moment";
import DiagnosticsPlugin from '../../scrypted/plugins/diagnostics/src/main';
import { scrypted } from '../package.json'

const divider = '-------------\n';

export default class RemoteBackup extends BasePlugin {
    private cronTasks: ScheduledTask[] = [];
    private currentChecksum: string;
    private diagnosticsPlugin: any;
    private tasksCheckListener: NodeJS.Timeout;
    storageSettings = new StorageSettings(this, {
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
        }
    });

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Monitor'
        });
        this.diagnosticsPlugin = new DiagnosticsPlugin();

        this.start(true).then().catch(console.log);
    }


    async start(shouldLog: boolean) {
        if (shouldLog) {
            const logger = this.getLogger();
            logger.log('Plugin enabled, starting');
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
            taskCalendarEntity
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
            devices: JSON.parse(this.storage.getItem(taskDevicesKey as any) as string ?? '[]'),
            additionalNotifiers: JSON.parse(this.storage.getItem(taskAdditionalNotifiers as any) as string ?? '[]'),
            enabled: JSON.parse(this.storage.getItem(taskEnabledKey) ?? 'true'),
            checkAllPlugins: JSON.parse(this.storage.getItem(taskCheckAllPluginsVersion) ?? 'true'),
            maxStats: JSON.parse(this.storage.getItem(taskMaxStatsKey) ?? '5'),
            entitiesToAlwaysReport: JSON.parse(this.storage.getItem(taskEntitiesToAlwaysReport as any) as string ?? '[]'),
            entitiesToExclude: JSON.parse(this.storage.getItem(taskEntitiesToExclude as any) as string ?? '[]'),
            batteryThreshold: JSON.parse(this.storage.getItem(taskBatteryThreshold) ?? '30'),
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
        } = task;

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
        } else if (type === TaskType.UpdatePlugins) {
            for (const pluginId of plugins) {
                const plugin = sdk.systemManager.getDeviceById(pluginId);
                const { manufacturer, version } = plugin.info;

                logger.log(`Updating plugin ${manufacturer}`);
                const newVersion = await updatePlugin(logger, manufacturer, version, beta);
                if (newVersion) {
                    message += `[${manufacturer}]: Updated ${version} -> ${newVersion}\n`;
                } else {
                    message += `[${manufacturer}]: Already on latest version ${version}\n`;
                }
            }

            if (checkAllPlugins) {
                const otherPlugins = getAllPlugins().map(pluginName => {
                    return sdk.systemManager.getDeviceByName(pluginName);
                }).filter(plugin => !plugins.includes(plugin.id));
                logger.log(`Checking other plugins: ${otherPlugins.map(plugin => plugin.name)}`);

                let somePluginOutdated = false;
                for (const plugin of otherPlugins) {
                    const { manufacturer, version } = plugin.info;
                    const { newVersion } = await pluginHasUpdate(logger, manufacturer, version, beta);
                    if (newVersion) {
                        somePluginOutdated = true;
                        message += `[${manufacturer}]: New version available ${newVersion}\n`;
                    }
                }
                if (!somePluginOutdated) {
                    message += `\nAll the other plugins are on the latest version\n`;
                }
            }
        } else if (type === TaskType.ReportPluginsStatus) {
            const stats = await getPluginStats(maxStats);
            logger.log(`Current stats: ${JSON.stringify(stats)}`);

            message += `[RPC Objects]\n${divider}`;
            stats.rpcObjects.forEach(item => message += `${item.name}: ${item.count}\n`);
            message += `${divider}[Pending Results]\n${divider}`;
            stats.pendingResults.forEach(item => message += `${item.name}: ${item.count}\n`);
            message += `${divider}[Connections]\n${divider}`;
            stats.connections.forEach(item => message += `${item.name}: ${item.count}`);
            if (stats.cluster) {
                message += `\n${divider}[Workers]\n${divider}`;
                stats.cluster.workers.forEach(item => message += `${item.name}: ${item.count}\n`);
                message += `${divider}[Devices]\n${divider}`;
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
            const statuses = await haApi.getStatesDate();
            let atLeast1LowBattery = false;
            const trackedEntries: string[] = [];

            statuses.data.forEach(entity => {
                if (!entitiesToExclude.includes(entity.entity_id) && entity.attributes.device_class === 'battery') {
                    if (entity.entity_id.startsWith('sensor.')) {
                        const messageToAdd = `${entity?.attributes?.friendly_name} (${entity.state}%)`;
                        if (entitiesToAlwaysReport.includes(entity.entity_id)) {
                            trackedEntries.push(messageToAdd);
                        } else if (Number(entity.state ?? -1) < batteryThreshold) {
                            message += `${messageToAdd}\n`;
                            atLeast1LowBattery = true;
                        }
                    } else if (entity.entity_id.startsWith('binary_sensor.')) {
                        const messageToAdd = `${entity?.attributes?.friendly_name}`;
                        if (entitiesToAlwaysReport.includes(entity.entity_id)) {
                            trackedEntries.push(messageToAdd);
                        } else if (entity.state === 'on') {
                            message += `${messageToAdd}\n`;
                            atLeast1LowBattery = true;
                        }
                    }
                }
            });

            if (trackedEntries.length) {
                if (atLeast1LowBattery) {
                    message += divider;
                }

                for (const trackedEntry of trackedEntries) {
                    message += `${trackedEntry}\n`
                }
            }

            if (!atLeast1LowBattery && !trackedEntries.length) {
                message += `All batteries ok\n`;
            }
        } else if (type === TaskType.TomorrowEventsHa) {
            logger.log(`Reporting tomorrow HA calendar events`);
            const haApi = await this.getHaApi();
            const fromDate = moment().add(1, 'days').startOf('day').toISOString().replace('T', ' ').split('.')[0];
            const endDate = moment().add(1, 'days').endOf('day').toISOString().replace('T', ' ').split('.')[0];
            const endDateWeek = moment().add(14, 'days').endOf('day').toISOString().replace('T', ' ').split('.')[0];
            const eventsResponse = await haApi.getCalendarEvents(
                calendarEntity,
                fromDate,
                endDate,
            );
            const eventsResponseWeek = await haApi.getCalendarEvents(
                calendarEntity,
                endDate,
                endDateWeek,
            );
            const events = eventsResponse.data.service_response[calendarEntity]?.events;
            logger.log(`Events found: ${events}`);

            for (const event of events) {
                message += `${event.summary}\n`;
            }

            const eventsNext2Weeks = eventsResponseWeek.data.service_response[calendarEntity]?.events;
            logger.log(`Next 2 weeks events found ${eventsNext2Weeks}`)

            if (eventsNext2Weeks.length) {
                if (events.length) {
                    message += divider;
                }

                for (const event of eventsNext2Weeks) {
                    message += `${event.summary} - ${moment(event.start, 'YYYY-MM-DD').locale('it').fromNow()}\n`;
                }
            }

            if (!events.length && !eventsNext2Weeks.length) {
                forceStop = true;
            }

            if (events.length) {
                priority = 1;
            }
        }
        else if (type === TaskType.RestartScrypted) {
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

    async startTaskCron(task: Task) {
        const logger = this.getLogger();
        try {
            const {
                cronScheduler,
                name,
            } = task;
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
                calendarEntity
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
                taskCalendarEntity
            } = getTaskKeys(task);
            const group = `Task: ${task}`;
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
                },
                {
                    key: taskCronKey,
                    title: 'Cron',
                    description: 'Cron string',
                    type: 'string',
                    value: cronScheduler,
                    placeholder: '0 */6 * * *',
                    group,
                }
            );

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
                settings.push({
                    key: taskPluginsKey,
                    title: 'Plugins',
                    group,
                    type: 'device',
                    value: plugins,
                    deviceFilter: `(interfaces.includes('${ScryptedInterface.ScryptedPlugin}'))`,
                    multiple: true,
                    combobox: true,
                });
            }

            if (type === TaskType.UpdatePlugins) {
                settings.push(
                    {
                        key: taskPluginsKey,
                        title: 'Plugins',
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
                    {
                        key: taskEntitiesToAlwaysReport,
                        title: 'Entities to always report',
                        group,
                        type: 'string',
                        value: entitiesToAlwaysReport,
                        multiple: true,
                        combobox: true,
                    },
                    {
                        key: taskEntitiesToExclude,
                        title: 'Entities to exclude',
                        group,
                        type: 'string',
                        value: entitiesToExclude,
                        multiple: true,
                        combobox: true,
                    }
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
                    }
                );
            }
        });

        return settings;
    }
}
