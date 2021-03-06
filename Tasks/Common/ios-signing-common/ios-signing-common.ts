import fs = require('fs');
import path = require('path');
import Q = require('q');
import tl = require('vsts-task-lib/task');
import { ToolRunner } from 'vsts-task-lib/toolrunner';

var userProvisioningProfilesPath = tl.resolve(tl.getVariable('HOME'), 'Library', 'MobileDevice', 'Provisioning Profiles');

/**
 * Creates a temporary keychain and installs the P12 cert in the specified keychain
 * @param keychainPath, the path to the keychain file
 * @param keychainPwd, the password to use for unlocking the keychain
 * @param p12CertPath, the P12 cert to be installed in the keychain
 * @param p12Pwd, the password for the P12 cert
 */
export async function installCertInTemporaryKeychain(keychainPath: string, keychainPwd: string, p12CertPath: string, p12Pwd: string, useKeychainIfExists: boolean) {
    let setupKeychain: boolean = true;

    if (useKeychainIfExists && tl.exist(keychainPath)) {
        setupKeychain = false;
    }

    if (setupKeychain) {
        //delete keychain if exists
        await deleteKeychain(keychainPath);

        //create keychain
        let createKeychainCommand: ToolRunner = tl.tool(tl.which('security', true));
        createKeychainCommand.arg(['create-keychain', '-p', keychainPwd, keychainPath]);
        await createKeychainCommand.exec();

        //update keychain settings
        let keychainSettingsCommand: ToolRunner = tl.tool(tl.which('security', true));
        keychainSettingsCommand.arg(['set-keychain-settings', '-lut', '7200', keychainPath]);
        await keychainSettingsCommand.exec();
    }

    //unlock keychain
    await unlockKeychain(keychainPath, keychainPwd);

    //import p12 cert into the keychain
    let importP12Command: ToolRunner = tl.tool(tl.which('security', true));
    if (!p12Pwd) {
        // if password is null or not defined, set it to empty
        p12Pwd = '';
    }
    importP12Command.arg(['import', p12CertPath, '-P', p12Pwd, '-A', '-t', 'cert', '-f', 'pkcs12', '-k', keychainPath]);
    await importP12Command.exec();

    //list the keychains to get current keychains in search path
    let listAllOutput: string;
    let listAllCommand: ToolRunner = tl.tool(tl.which('security', true));
    listAllCommand.arg(['list-keychain', '-d', 'user']);
    listAllCommand.on('stdout', function (data) {
        if (data) {
            if (listAllOutput) {
                listAllOutput = listAllOutput.concat(data.toString().trim());
            } else {
                listAllOutput = data.toString().trim();
            }
        }
    })

    await listAllCommand.exec();

    let allKeychainsArr: string[] = [];
    tl.debug('listAllOutput = ' + listAllOutput);

    //parse out all the existing keychains in search path
    if (listAllOutput) {
        allKeychainsArr = listAllOutput.split(/[\n\r\f\v]/gm);
    }

    //add the keychain to list path along with existing keychains if it is not in the path
    if (listAllOutput && listAllOutput.indexOf(keychainPath) < 0) {
        let listAddCommand: ToolRunner = tl.tool(tl.which('security', true));
        listAddCommand.arg(['list-keychain', '-d', 'user', '-s', keychainPath]);
        for (var i: number = 0; i < allKeychainsArr.length; i++) {
            listAddCommand.arg(allKeychainsArr[i].trim().replace(/"/gm, ''));
        }

        await listAddCommand.exec();
    }

    let listVerifyOutput: string;
    let listVerifyCommand: ToolRunner = tl.tool(tl.which('security', true));
    listVerifyCommand.arg(['list-keychain', '-d', 'user']);
    listVerifyCommand.on('stdout', function (data) {
        if (data) {
            if (listVerifyOutput) {
                listVerifyOutput = listVerifyOutput.concat(data.toString().trim());
            } else {
                listVerifyOutput = data.toString().trim();
            }
        }
    })

    await listVerifyCommand.exec();

    if (!listVerifyOutput || listVerifyOutput.indexOf(keychainPath) < 0) {
        throw tl.loc('TempKeychainSetupFailed');
    }

}

/**
 * Finds an iOS codesigning identity in the specified keychain
 * @param keychainPath
 * @returns {string} signing identity found
 */
export async function findSigningIdentity(keychainPath: string) {
    let signIdentity: string;
    let findIdentityCmd: ToolRunner = tl.tool(tl.which('security', true));
    findIdentityCmd.arg(['find-identity', '-v', '-p', 'codesigning', keychainPath]);
    findIdentityCmd.on('stdout', function (data) {
        if (data) {
            let matches = data.toString().trim().match(/"(.+)"/g);
            tl.debug('signing identity data = ' + matches);
            if (matches && matches[0]) {
                signIdentity = matches[0].replace(/"/gm, '');
                tl.debug('signing identity data trimmed = ' + signIdentity);
            }
        }
    })

    await findIdentityCmd.exec();
    if (signIdentity) {
        tl.debug('findSigningIdentity = ' + signIdentity);
        return signIdentity;
    } else {
        throw tl.loc('SignIdNotFound');
    }
}

/**
 * Get Cloud entitlement type Production or Development according to the export method - if entitlement doesn't exists in provisioning profile returns null
 * @param provisioningProfilePath
 * @param exportMethod
 * @returns {string}
 */
export async function getCloudEntitlement(provisioningProfilePath: string, exportMethod: string): Promise<string> {
    //find the provisioning profile details
    let provProfileDetails: string;
    const getProvProfileDetailsCmd: ToolRunner = tl.tool(tl.which('security', true));
    getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provisioningProfilePath]);
    getProvProfileDetailsCmd.on('stdout', function (data) {
        if (data) {
            if (provProfileDetails) {
                provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
            } else {
                provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
            }
        }
    });

    await getProvProfileDetailsCmd.exec();

    let tmpPlist: string;
    if (provProfileDetails) {
        //write the provisioning profile to a plist
        tmpPlist = '_xcodetasktmp.plist';
        tl.writeFile(tmpPlist, provProfileDetails);
    } else {
        throw tl.loc('ProvProfileDetailsNotFound', provisioningProfilePath);
    }

    //use PlistBuddy to figure out if cloud entitlement exists.
    const cloudEntitlement: string = await printFromPlist('Entitlements:com.apple.developer.icloud-container-environment', tmpPlist);

    //delete the temporary plist file
    const deletePlistCommand: ToolRunner = tl.tool(tl.which('rm', true));
    deletePlistCommand.arg(['-f', tmpPlist]);
    await deletePlistCommand.exec();

    if (!cloudEntitlement) {
        return null;
    }

    tl.debug('Provisioning Profile contains cloud entitlement');
    return (exportMethod === 'app-store' || exportMethod === 'enterprise' || exportMethod === 'developer-id')
                ? "Production"
                : "Development";
}

/**
 * Find the UUID of the provisioning profile and install the profile
 * @param provProfilePath
 * @returns {string} UUID
 */
export async function getProvisioningProfileUUID(provProfilePath: string) {

    //find the provisioning profile UUID
    let provProfileDetails: string;
    let getProvProfileDetailsCmd: ToolRunner = tl.tool(tl.which('security', true));
    getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
    getProvProfileDetailsCmd.on('stdout', function (data) {
        if (data) {
            if (provProfileDetails) {
                provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
            } else {
                provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
            }
        }
    })
    await getProvProfileDetailsCmd.exec();

    let tmpPlist: string;
    if (provProfileDetails) {
        //write the provisioning profile to a plist
        tmpPlist = '_xcodetasktmp.plist';
        fs.writeFileSync(tmpPlist, provProfileDetails);
    } else {
        throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
    }

    //use PlistBuddy to figure out the UUID
    let provProfileUUID: string;
    let plist = tl.which('/usr/libexec/PlistBuddy', true);
    let plistTool: ToolRunner = tl.tool(plist);
    plistTool.arg(['-c', 'Print UUID', tmpPlist]);
    plistTool.on('stdout', function (data) {
        if (data) {
            provProfileUUID = data.toString();
        }
    })
    await plistTool.exec();

    //delete the temporary plist file
    let deletePlistCommand: ToolRunner = tl.tool(tl.which('rm', true));
    deletePlistCommand.arg(['-f', tmpPlist]);
    await deletePlistCommand.exec();

    if (provProfileUUID) {
        //copy the provisioning profile file to ~/Library/MobileDevice/Provisioning Profiles
        tl.mkdirP(userProvisioningProfilesPath); // Path may not exist if Xcode has not been run yet.
        let pathToProvProfile: string = getProvisioningProfilePath(provProfileUUID);
        let copyProvProfileCmd: ToolRunner = tl.tool(tl.which('cp', true));
        copyProvProfileCmd.arg(['-f', provProfilePath, pathToProvProfile]);
        await copyProvProfileCmd.exec();

        return provProfileUUID;
    } else {
        throw tl.loc('ProvProfileUUIDNotFound', provProfilePath);
    }
}

/**
 * Find the Name of the provisioning profile
 * @param provProfilePath
 * @returns {string} Name
 */
export async function getProvisioningProfileName(provProfilePath: string) {

    //find the provisioning profile UUID
    let provProfileDetails: string;
    let getProvProfileDetailsCmd: ToolRunner = tl.tool(tl.which('security', true));
    getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
    getProvProfileDetailsCmd.on('stdout', function (data) {
        if (data) {
            if (provProfileDetails) {
                provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
            } else {
                provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
            }
        }
    })
    await getProvProfileDetailsCmd.exec();

    let tmpPlist: string;
    if (provProfileDetails) {
        //write the provisioning profile to a plist
        tmpPlist = '_xcodetasktmp.plist';
        fs.writeFileSync(tmpPlist, provProfileDetails);
    } else {
        throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
    }

    //use PlistBuddy to figure out the Name
    let provProfileName: string = await printFromPlist('Name', tmpPlist);

    //delete the temporary plist file
    let deletePlistCommand: ToolRunner = tl.tool(tl.which('rm', true));
    deletePlistCommand.arg(['-f', tmpPlist]);
    await deletePlistCommand.exec();

    tl.debug('getProvisioningProfileName: profile name = ' + provProfileName);
    return provProfileName;
}

/**
 * Find the type of the iOS provisioning profile - app-store, ad-hoc, enterprise or development
 * @param provProfilePath
 * @returns {string} type
 */
export async function getiOSProvisioningProfileType(provProfilePath: string) {
    let provProfileType: string;
    try {
        //find the provisioning profile details
        let provProfileDetails: string;
        let getProvProfileDetailsCmd: ToolRunner = tl.tool(tl.which('security', true));
        getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
        getProvProfileDetailsCmd.on('stdout', function (data) {
            if (data) {
                if (provProfileDetails) {
                    provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
                } else {
                    provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
                }
            }
        })
        await getProvProfileDetailsCmd.exec();

        let tmpPlist: string;
        if (provProfileDetails) {
            //write the provisioning profile to a plist
            tmpPlist = '_xcodetasktmp.plist';
            fs.writeFileSync(tmpPlist, provProfileDetails);
        } else {
            throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
        }

        //get ProvisionsAllDevices - this will exist for enterprise profiles
        let provisionsAllDevices: string = await printFromPlist('ProvisionsAllDevices', tmpPlist);
        tl.debug('provisionsAllDevices = ' + provisionsAllDevices);
        if (provisionsAllDevices && provisionsAllDevices.trim().toLowerCase() === 'true') {
            //ProvisionsAllDevices = true in enterprise profiles
            provProfileType = 'enterprise';
        } else {
            let getTaskAllow: string = await printFromPlist('Entitlements:get-task-allow', tmpPlist);
            tl.debug('getTaskAllow = ' + getTaskAllow);
            if (getTaskAllow && getTaskAllow.trim().toLowerCase() === 'true') {
                //get-task-allow = true means it is a development profile
                provProfileType = 'development';
            } else {
                let provisionedDevices: string = await printFromPlist('ProvisionedDevices', tmpPlist);
                if (!provisionedDevices) {
                    // no provisioned devices for non-development profile means it is an app-store profile
                    provProfileType = 'app-store';
                } else {
                    // non-development profile with provisioned devices - use ad-hoc
                    provProfileType = 'ad-hoc';
                }
            }
        }

        //delete the temporary plist file
        let deletePlistCommand: ToolRunner = tl.tool(tl.which('rm', true));
        deletePlistCommand.arg(['-f', tmpPlist]);
        await deletePlistCommand.exec();
    } catch (err) {
        tl.debug(err);
    }

    return provProfileType;
}

/**
 * Find the type of the macOS provisioning profile - app-store, developer-id or development.
 * mac-application is a fourth macOS export method, but it doesn't include signing.
 * @param provProfilePath
 * @returns {string} type
 */
export async function getmacOSProvisioningProfileType(provProfilePath: string) {
    let provProfileType: string;
    try {
        //find the provisioning profile details
        let provProfileDetails: string;
        let getProvProfileDetailsCmd: ToolRunner = tl.tool(tl.which('security', true));
        getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
        getProvProfileDetailsCmd.on('stdout', function (data) {
            if (data) {
                if (provProfileDetails) {
                    provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
                } else {
                    provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
                }
            }
        })
        await getProvProfileDetailsCmd.exec();

        let tmpPlist: string;
        if (provProfileDetails) {
            //write the provisioning profile to a plist
            tmpPlist = '_xcodetasktmp.plist';
            fs.writeFileSync(tmpPlist, provProfileDetails);
        } else {
            throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
        }

        //get ProvisionsAllDevices - this will exist for developer-id profiles
        let provisionsAllDevices: string = await printFromPlist('ProvisionsAllDevices', tmpPlist);
        tl.debug('provisionsAllDevices = ' + provisionsAllDevices);
        if (provisionsAllDevices && provisionsAllDevices.trim().toLowerCase() === 'true') {
            //ProvisionsAllDevices = true in developer-id profiles
            provProfileType = 'developer-id';
        } else {
            let provisionedDevices: string = await printFromPlist('ProvisionedDevices', tmpPlist);
            if (!provisionedDevices) {
                // no provisioned devices means it is an app-store profile
                provProfileType = 'app-store';
            } else {
                // profile with provisioned devices - use development
                provProfileType = 'development';
            }
        }

        //delete the temporary plist file
        let deletePlistCommand: ToolRunner = tl.tool(tl.which('rm', true));
        deletePlistCommand.arg(['-f', tmpPlist]);
        await deletePlistCommand.exec();
    } catch (err) {
        tl.debug(err);
    }

    return provProfileType;
}

/**
 * Find the bundle identifier in the specified Info.plist
 * @param plistPath
 * @returns {string} bundle identifier
 */
export async function getBundleIdFromPlist(plistPath: string) {
    let bundleId: string = await printFromPlist('CFBundleIdentifier', plistPath);
    tl.debug('getBundleIdFromPlist bundleId = ' + bundleId);
    return bundleId;
}

async function printFromPlist(itemToPrint: string, plistPath: string) {
    let plist = tl.which('/usr/libexec/PlistBuddy', true);
    let plistTool: ToolRunner = tl.tool(plist);
    plistTool.arg(['-c', 'Print ' + itemToPrint, plistPath]);

    let printedValue: string;
    plistTool.on('stdout', function (data) {
        if (data) {
            printedValue = data.toString().trim();
        }
    });

    try {
        await plistTool.exec();
    } catch (err) {
        tl.debug('Exception when looking for ' + itemToPrint + ' in plist.');
        printedValue = null;
    }

    return printedValue;
}

/**
 * Delete specified iOS keychain
 * @param keychainPath
 */
export async function deleteKeychain(keychainPath: string) {
    if (fs.existsSync(keychainPath)) {
        let deleteKeychainCommand: ToolRunner = tl.tool(tl.which('security', true));
        deleteKeychainCommand.arg(['delete-keychain', keychainPath]);
        await deleteKeychainCommand.exec();
    }
}

/**
 * Unlock specified iOS keychain
 * @param keychainPath
 * @param keychainPwd
 */
export async function unlockKeychain(keychainPath: string, keychainPwd: string) {
    //unlock the keychain
    let unlockCommand: ToolRunner = tl.tool(tl.which('security', true));
    unlockCommand.arg(['unlock-keychain', '-p', keychainPwd, keychainPath]);
    await unlockCommand.exec();
}

/**
 * Delete provisioning profile with specified UUID in the user's profiles directory
 * @param uuid
 */
export async function deleteProvisioningProfile(uuid: string) {
    let provProfilePath: string = getProvisioningProfilePath(uuid);
    tl.warning('Deleting provisioning profile: ' + provProfilePath);
    if (fs.existsSync(provProfilePath)) {
        let deleteProfileCommand: ToolRunner = tl.tool(tl.which('rm', true));
        deleteProfileCommand.arg(['-f', provProfilePath]);
        await deleteProfileCommand.exec();
    }
}

function getProvisioningProfilePath(uuid: string): string {
    return tl.resolve(userProvisioningProfilesPath, uuid.trim().concat('.mobileprovision'));
}

/**
 * Gets the path to the iOS default keychain
 */
export async function getDefaultKeychainPath() {
    let defaultKeychainPath: string;
    let getKeychainCmd: ToolRunner = tl.tool(tl.which('security', true));
    getKeychainCmd.arg('default-keychain');
    getKeychainCmd.on('stdout', function (data) {
        if (data) {
            defaultKeychainPath = data.toString().trim().replace(/[",\n\r\f\v]/gm, '');
        }
    })
    await getKeychainCmd.exec();
    return defaultKeychainPath;
}

/**
 * Gets the path to the temporary keychain path used during build or release
 */
export function getTempKeychainPath() {
    let keychainName: string = 'ios_signing_temp.keychain';
    let getTempKeychainPath: string = tl.resolve(tl.getVariable('Agent.TempDirectory'), keychainName);
    return getTempKeychainPath;
}

export async function getP12SHA1Hash(p12Path: string, p12Pwd: string) {
    //openssl pkcs12 -in <p12Path> -nokeys -passin pass:"<p12Pwd>" | openssl x509 -noout –fingerprint
    let opensslPath: string = tl.which('openssl', true);
    let openssl1: ToolRunner = tl.tool(opensslPath);
    if (!p12Pwd) {
        // if password is null or not defined, set it to empty
        p12Pwd = '';
    }
    openssl1.arg(['pkcs12', '-in', p12Path, '-nokeys', '-passin', 'pass:' + p12Pwd]);

    let openssl2: ToolRunner = tl.tool(opensslPath);
    openssl2.arg(['x509', '-noout', '-fingerprint']);
    openssl1.pipeExecOutputToTool(openssl2);

    let sha1Hash: string;
    openssl1.on('stdout', function (data) {
        if (data) {
            // find the fingerprint
            data = data.toString().trim();
            let fingerprint: string[] = data.match(/SHA1 Fingerprint=.+/g);
            if (fingerprint && fingerprint[0]) {
                sha1Hash = fingerprint[0].replace('SHA1 Fingerprint=', '').replace(/:/g, '').trim();
            }
        }
    })

    try {
        await openssl1.exec();
    } catch (err) {
        if (!p12Pwd) {
            tl.warning(tl.loc('NoP12PwdWarning'));
        }
        throw err;
    }

    tl.debug('P12 SHA1 hash = ' + sha1Hash);
    return sha1Hash;
}

export async function getP12CommonName(p12Path: string, p12Pwd: string) {
    //openssl pkcs12 -in <p12Path> -nokeys -passin pass:"<p12Pwd>" | openssl x509 -noout –subject
    let opensslPath: string = tl.which('openssl', true);
    let openssl1: ToolRunner = tl.tool(opensslPath);
    if (!p12Pwd) {
        // if password is null or not defined, set it to empty
        p12Pwd = '';
    }
    openssl1.arg(['pkcs12', '-in', p12Path, '-nokeys', '-passin', 'pass:' + p12Pwd]);

    let openssl2: ToolRunner = tl.tool(opensslPath);
    openssl2.arg(['x509', '-noout', '-subject']);
    openssl1.pipeExecOutputToTool(openssl2);

    let commonName: string;
    openssl1.on('stdout', function (data) {
        if (data) {
            // find the subject
            data = data.toString().trim();
            let subject: string[] = data.match(/subject=.+\/CN=.+\(?.+\)?.+/g);
            if (subject && subject[0]) {
                // find the CN from the subject
                let cn: string[] = subject[0].trim().split('/').filter((s) => {
                    return s.startsWith('CN=')
                });
                if (cn && cn[0]) {
                    commonName = cn[0].replace('CN=', '').trim();
                }
            }
        }
    })
    await openssl1.exec();
    tl.debug('P12 common name (CN) = ' + commonName);
    return commonName;
}

export async function deleteCert(keychainPath: string, certSha1Hash: string) {
    let deleteCert: ToolRunner = tl.tool(tl.which('security', true));
    deleteCert.arg(['delete-certificate', '-Z', certSha1Hash, keychainPath]);
    await deleteCert.exec();
}
