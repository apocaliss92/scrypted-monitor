import sdk, { Notifier, Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import cron, { ScheduledTask } from 'node-cron';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getTaskChecksum, getTaskKeys, restartPlugin, runValidate, Task, TaskType, updatePlugin, ValidationResult } from "./utils";
import DiagnosticsPlugin from './diagnostics/main.nodejs.js';

export default class RemoteBackup extends BasePlugin {
    private cronTasks: ScheduledTask[] = [];
    private currentChecksum: string;
    private diagnosticsPlugin;
    private tasksCheckListener: NodeJS.Timeout;
    storageSettings = new StorageSettings(this, {
        ...getBaseSettings({ onPluginSwitch: (_, enabled) => this.startStop(enabled) }),
        tasks: {
            title: 'Tasks',
            multiple: true,
            combobox: true,
            type: 'string',
            choices: [],
        },
    });

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Monitor'
        });
        this.diagnosticsPlugin = new DiagnosticsPlugin();

        this.start(true).then().catch(console.log);
        // runValidate(this.diagnosticsPlugin, this.console).then(() => {
        //     runValidate(this.diagnosticsPlugin, this.console, '357').then().catch(console.log);
        // }).catch(console.log);
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

    async getTasks() {
        const { tasks } = this.storageSettings.values;
        const taskEntities: Task[] = [];

        tasks.forEach((task: string) => {
            const {
                taskCronKey,
                taskDevicesKey,
                taskPluginsKey,
                taskTypeKey,
                taskRebootKey,
                taskEnabledKey,
                taskSystemDiagnostic,
                taskBetaKey,
            } = getTaskKeys(task);

            if (JSON.parse(this.storage.getItem(taskEnabledKey) ?? 'true')) {
                taskEntities.push({
                    name: task,
                    type: this.storage.getItem(taskTypeKey) as TaskType,
                    cronScheduler: this.storage.getItem(taskCronKey),
                    rebootOnErrors: JSON.parse(this.storage.getItem(taskRebootKey) ?? 'false'),
                    runSystemDiagnostic: JSON.parse(this.storage.getItem(taskSystemDiagnostic) ?? 'true'),
                    beta: JSON.parse(this.storage.getItem(taskBetaKey) ?? 'false'),
                    plugins: JSON.parse(this.storage.getItem(taskPluginsKey as any) as string ?? '[]'),
                    devices: JSON.parse(this.storage.getItem(taskDevicesKey as any) as string ?? '[]'),
                });
            }
        });

        return taskEntities;
    }

    async executeTask(task: Task) {
        try {
            const {
                cronScheduler,
                name,
                rebootOnErrors,
                type,
                devices,
                plugins,
                runSystemDiagnostic,
                beta,
            } = task;
            if (cronScheduler) {
                const logger = this.getLogger();
                logger.log(`Starting scheduler ${name} with cron ${cronScheduler} `);
                const newTask = cron.schedule(cronScheduler, async () => {
                    let message = ``;
                    const title = `Task ${name} (${type})`;

                    if (type === TaskType.Diagnostics) {
                        for (const deviceId of devices) {
                            const device = sdk.systemManager.getDeviceById(deviceId) as unknown as ScryptedDeviceBase & Reboot;
                            logger.log(`Starting ${type} for ${device.name}`);
                            const result = await runValidate(this.diagnosticsPlugin, this.console, deviceId);
                            logger.log(`Result for ${type}-${name}: ${JSON.stringify(result)}`);
                            message += `[${device.name} Diagnostic]: ${result.text}`;

                            if (rebootOnErrors && result.errorSteps.length > 0 && device.interfaces.includes(ScryptedInterface.Reboot)) {
                                message += ` | Restarting |`;
                                logger.log(`Restarting ${device.name}`);
                                await device.reboot();
                            }

                            message += `\n`;
                        }

                        if (runSystemDiagnostic) {
                            logger.log(`Starting ${type} for System`);
                            const result = await runValidate(this.diagnosticsPlugin, this.console);
                            logger.log(`Result for ${type}-System: ${JSON.stringify(result)}`);
                            message += `[System diagnostic]: ${result.text}}`
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
                    }

                    const { devNotifier } = this.storageSettings.values;
                    if (devNotifier) {
                        this.console.log(`Sending notification to ${devNotifier.name}: ${JSON.stringify({ title, message })}`);
                        await devNotifier.sendNotification(title, {
                            body: message,
                        });
                    }
                });

                this.cronTasks.push(newTask);
            }
        } catch (e) {
            this.console.log('Error executing task', task, e);
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
                await this.executeTask(task);
            }
        }
    }

    async testTask() {

    }

    async getSettings() {
        const { tasks } = this.storageSettings.values;
        const settings: Setting[] = await this.storageSettings.getSettings();

        (tasks as string[]).forEach(task => {
            const {
                taskCronKey,
                taskDevicesKey,
                taskPluginsKey,
                taskTypeKey,
                taskRebootKey,
                taskEnabledKey,
                taskSystemDiagnostic,
                taskBetaKey,
            } = getTaskKeys(task);
            const taskType = this.storage.getItem(taskTypeKey) as TaskType;

            settings.push(
                {
                    key: taskEnabledKey,
                    title: 'Enabled',
                    group: task,
                    type: 'boolean',
                    value: JSON.parse(this.storage.getItem(taskEnabledKey) ?? 'true'),
                    immediate: true,
                },
                {
                    key: taskTypeKey,
                    title: 'Task type',
                    type: 'string',
                    choices: [TaskType.UpdatePlugins, TaskType.RestartPlugins, TaskType.Diagnostics],
                    value: taskType,
                    group: task,
                    immediate: true
                },
                {
                    key: taskCronKey,
                    title: 'Cron',
                    description: 'Cron string',
                    type: 'string',
                    value: this.storage.getItem(taskCronKey),
                    placeholder: '0 */6 * * *',
                    group: task,
                }
            );

            if ([TaskType.RestartPlugins, TaskType.UpdatePlugins].includes(taskType)) {
                settings.push({
                    key: taskPluginsKey,
                    title: 'Plugins',
                    group: task,
                    type: 'device',
                    value: JSON.parse(this.storage.getItem(taskPluginsKey as any) as string ?? '[]'),
                    deviceFilter: `(interfaces.includes('${ScryptedInterface.ScryptedPlugin}'))`,
                    multiple: true,
                    combobox: true,
                });
            }

            if (taskType === TaskType.UpdatePlugins) {
                settings.push(
                    {
                        key: taskBetaKey,
                        title: 'Use Beta versions',
                        group: task,
                        type: 'boolean',
                        value: JSON.parse(this.storage.getItem(taskBetaKey) ?? 'false'),
                        immediate: true,
                    }
                );
            }

            if (taskType === TaskType.Diagnostics) {
                settings.push(
                    {
                        key: taskDevicesKey,
                        title: 'Devices',
                        group: task,
                        type: 'device',
                        value: JSON.parse(this.storage.getItem(taskDevicesKey as any) as string ?? '[]'),
                        deviceFilter: `type === '${ScryptedDeviceType.Camera}' || type === '${ScryptedDeviceType.Doorbell}'  || type === '${ScryptedDeviceType.Notifier}'`,
                        immediate: true,
                        multiple: true,
                        combobox: true,
                    },
                    {
                        key: taskSystemDiagnostic,
                        title: 'Execute system diagnostic',
                        group: task,
                        type: 'boolean',
                        value: JSON.parse(this.storage.getItem(taskSystemDiagnostic) ?? 'true'),
                        immediate: true,
                    },
                    {
                        key: taskRebootKey,
                        title: 'Reboot cameras on errors',
                        group: task,
                        type: 'boolean',
                        value: JSON.parse(this.storage.getItem(taskRebootKey) ?? '[]'),
                        immediate: true,
                    },
                );
            }
        });

        return settings;
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }
}