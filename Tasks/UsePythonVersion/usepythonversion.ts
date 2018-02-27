import * as path from 'path';

import * as semver from 'semver';

import * as task from 'vsts-task-lib/task';
import * as tool from 'vsts-task-tool-lib/tool';

enum Platform {
    Windows,
    MacOS,
    Linux
}

/**
 * Determine the operating system the build agent is running on.
 */
function getPlatform(): Platform {
    switch (process.platform) {
        case 'win32': return Platform.Windows;
        case 'darwin': return Platform.MacOS;
        case 'linux': return Platform.Linux;
        default: throw Error("Platform not recognized"); // TODO loc
    }
}

async function run(): Promise<void> {
    try {
        task.setResourcePath(path.join(__dirname, 'task.json'));
        await usePythonVersion({
            versionSpec: task.getInput('versionSpec', true),
            outputVariable: task.getInput('outputVariable', true),
            addToPath: task.getBoolInput('addToPath', true)
        },
        getPlatform());
        task.setResult(task.TaskResult.Succeeded, "");
    } catch (error) {
        task.error(error.message);
        task.setResult(task.TaskResult.Failed, error.message);
    }
}

interface TaskParameters {
    readonly versionSpec: string,
    readonly outputVariable: string,
    readonly addToPath: boolean
}

async function usePythonVersion(parameters: TaskParameters, platform: Platform): Promise<void> {
    validateVersionSpec(parameters.versionSpec);
    const installDir = await retrieveFromCache(parameters.versionSpec, platform);
    task.setVariable(parameters.outputVariable, installDir);
    if (parameters.addToPath) {
        addToPath(installDir, platform);
        addToPath(scriptsDirectory(platform), platform);
    }
}

/**
 * Throw an error if `input` is not a valid Python version specifier.
 * @param input A string possibly representing a version specifier
 */
function validateVersionSpec(input: string): void {
    // TODO Python prerelease specifiers?
    if (!semver.parse(input)) {
        throw Error(); // TODO message
    }
}

/**
 * Retrieve from the cache the latest Python version matching `versionSpec`.
 * @param versionSpec A valid semver version specifier string (like 3.x)
 * @param platform OS the build agent is running on
 * @returns Path that Python was installed to
 */
async function retrieveFromCache(versionSpec: string, platform: Platform): Promise<string> {
    // TODO
    return Promise.resolve("");
}

/**
 * Look up the directory where Pip will install command-line tools for `platform`.
 * @param platform OS the build agent is running on
 */
function scriptsDirectory(platform: Platform): string {
    // TODO
    switch (platform) {
        default: return "";
    }
}

/**
 * Add `directory` to the PATH variable for the platform.
 */
function addToPath(directory: string, platform: Platform): void {
    // TODO
}

run();