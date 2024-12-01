import sdk, { Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import cron, { ScheduledTask } from 'node-cron';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getPluginStats, getTaskChecksum, getTaskKeys, restartPlugin, runValidate, Task, TaskType, updatePlugin } from "./utils";
import DiagnosticsPlugin from './diagnostics/main.nodejs.js';

export default class RemoteBackup extends BasePlugin {
    private cronTasks: ScheduledTask[] = [];
    private currentChecksum: string;
    private diagnosticsPlugin;
    private tasksCheckListener: NodeJS.Timeout;
    storageSettings = new StorageSettings(this, {
        ...getBaseSettings({
            onPluginSwitch: (_, enabled) => this.startStop(enabled),
            hideMqtt: true,
        }),
        tasks: {
            title: 'Tasks',
            multiple: true,
            combobox: true,
            type: 'string',
            choices: [],
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
            enabled: JSON.parse(this.storage.getItem(taskEnabledKey) ?? 'true'),
            maxStats: JSON.parse(this.storage.getItem(taskMaxStatsKey) ?? '5'),
        };
    }

    async getTasks() {
        const { tasks } = this.storageSettings.values;
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
        } = task;

        let message = ``;
        const title = `Task ${name} (${type})`;

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
            for (const pluginId of plugins) {
                const plugin = sdk.systemManager.getDeviceById(pluginId);
                const packageName = plugin.info.manufacturer;

                logger.log(`Restarting plugin ${packageName}`);
                await restartPlugin(packageName);
                message += `[${packageName}]: Restarted\n`;
            }
        } else if (type === TaskType.UpdatePlugins) {
            for (const pluginId of plugins) {
                const plugin = sdk.systemManager.getDeviceById(pluginId);
                const { manufacturer, version } = plugin.info;

                logger.log(`Updating plugin ${manufacturer}`);
                const result = await updatePlugin(logger, manufacturer, version, beta);
                if (result.updated) {
                    message += `[${manufacturer}]: Updated ${version} -> ${result.newVersion}\n`;
                } else {
                    message += `[${manufacturer}]: Already on latest version ${version}\n`;
                }
            }
        } else if (type === TaskType.ReportPluginsStatus) {
            const stats = await getPluginStats(maxStats);
            logger.log(`Current stats: ${JSON.stringify(stats)}`);

            const divider = '-------------\n';
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
        }

        const { notifier } = this.storageSettings.values;
        if (notifier) {
            if (!skipNotify) {
                logger.log(`Sending notification to ${notifier.name}: ${JSON.stringify({ title, message })}`);
                await notifier.sendNotification(title, {
                    body: message,
                });
            } else {
                logger.log(`Skipping notification`);
            }
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
                runSystemDiagnostic
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
                taskSkipNotify
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
                    }
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
        });

        return settings;
    }
}