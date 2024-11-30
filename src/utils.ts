import sdk from "@scrypted/sdk";
import { throttle } from "lodash";
import semver from 'semver';

export enum TaskType {
    UpdatePlugins = 'UpdatePlugins',
    RestartPlugins = 'RestartPlugins',
    Diagnostics = 'Diagnostics',
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
    beta: boolean;
    runSystemDiagnostic?: boolean;
    plugins?: string[];
    devices?: string[];
}

const throttles = new Map<string, () => Promise<any>>();
const cache: Record<string, PluginUpdateCheck> = {};

async function checkNpmUpdate(npmPackage: string, npmPackageVersion: string, logger: Console): Promise<PluginUpdateCheck> {
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
        let updateAvailable: any;
        let updatePublished: any;
        let latest: any;
        if (data["dist-tags"]) {
            latest = data["dist-tags"].latest;
            if (npmPackageVersion && semver.gt(latest, npmPackageVersion)) {
                updateAvailable = latest;
                try {
                    updatePublished = new Date(data["time"][latest]);
                } catch {
                    updatePublished = null;
                }
            }
        }
        for (const [k, v] of Object.entries(data['dist-tags'])) {
            const found: any = versions.find((version: any) => version.version === v);
            if (found) {
                found.tag = k;
            }
        }
        // make sure latest build is first instead of a beta.
        if (latest) {
            const index = versions.findIndex((v: any) => v.version === latest);
            const [spliced] = versions.splice(index, 1);
            versions.unshift(spliced);
        }
        return {
            updateAvailable,
            updatePublished,
            versions: (versions as NpmVersion[]).map(version => {
                return {
                    ...version,
                    tag: version.tag || '',
                    time: new Date(time[version.version]).toLocaleDateString(),
                };
            }),
        };
    } catch (e) {
        logger.log('Error in checkNpm', e);
    }
}

export const restartPlugin = async (pluginName: string) => {
    const plugins = await sdk.systemManager.getComponent('plugins');
    await plugins.reload(pluginName);
}

export const updatePlugin = async (
    logger: Console,
    pluginName: string,
    currentVersion: string,
    beta?: boolean
) => {
    const status = await checkNpmUpdate(pluginName, currentVersion, logger);

    if (!status) {
        logger.log(`No data found for plugin ${pluginName}`);
        return;
    }

    let latestVersion = status.versions[0];
    if (latestVersion.tag === 'beta' && !beta) {
        latestVersion = status.versions.find(elem => elem.tag === '');
    }

    let updated;
    let newVersion;
    if (latestVersion.version !== currentVersion) {
        updated = true;
        newVersion = latestVersion.version;
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

    return {
        taskTypeKey,
        taskDevicesKey,
        taskPluginsKey,
        taskCronKey,
        taskRebootKey,
        taskEnabledKey,
        taskSystemDiagnostic,
        taskBetaKey,
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