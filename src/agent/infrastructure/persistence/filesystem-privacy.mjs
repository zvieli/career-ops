import { constants, closeSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

const POSIX_MODE_MASK = 0o077;

/**
 * Reports which filesystem privacy guarantees this runtime can verify.
 * Windows ACLs are deliberately never reported as verified: Node does not
 * expose a reliable effective-ACL audit here.
 */
export function filesystemPrivacyCapabilities(platform = process.platform) {
  const posixModeEnforcement = platform !== 'win32';
  return Object.freeze({
    platform,
    POSIX_MODE_ENFORCEMENT: posixModeEnforcement,
    WINDOWS_ACL_ENVIRONMENT: platform === 'win32',
    WINDOWS_ACL_VERIFIED: false,
    SYMLINK_SUPPORT: true,
    POSIX_PRIVATE_DIRECTORY_CREATION: posixModeEnforcement,
    POSIX_PRIVATE_FILE_CREATION: posixModeEnforcement,
    NO_FOLLOW_OPEN: platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number',
  });
}

function isPosix(platform) { return filesystemPrivacyCapabilities(platform).POSIX_MODE_ENFORCEMENT; }

export function assertPrivateDirectory(stat, message = 'Directory must be private and not a symlink.', platform = process.platform) {
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (isPosix(platform) && (stat.mode & POSIX_MODE_MASK) !== 0)) throw new Error(message);
}

export function assertPrivateRegularFile(stat, message = 'File must be private and regular.', platform = process.platform) {
  if (!stat.isFile() || stat.isSymbolicLink()
    || (isPosix(platform) && (stat.mode & POSIX_MODE_MASK) !== 0)) throw new Error(message);
}

function sameFile(before, after) {
  return Number.isSafeInteger(before.dev) && Number.isSafeInteger(before.ino)
    && Number.isSafeInteger(after.dev) && Number.isSafeInteger(after.ino)
    && before.dev === after.dev && before.ino === after.ino;
}

function validateOpenedPath(path, fd, before, platform) {
  const descriptor = fstatSync(fd);
  if (!descriptor.isFile()) throw new Error('Private file descriptor is not a regular file.');
  assertPrivateRegularFile(descriptor, 'Private file descriptor is not private and regular.', platform);
  const after = lstatSync(path);
  assertPrivateRegularFile(after, 'Private file path is not a private regular file.', platform);
  if (!sameFile(after, descriptor) || (before && !sameFile(before, descriptor))) {
    throw new Error('Private file changed identity while opening; refusing access.');
  }
}

function openNoFollow(path, flags, mode, platform = process.platform) {
  let before;
  try { before = lstatSync(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (before) assertPrivateRegularFile(before, 'Refusing to open a non-regular or symlinked private file.', platform);

  const noFollow = filesystemPrivacyCapabilities(platform).NO_FOLLOW_OPEN ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, flags | noFollow, mode);
  try {
    validateOpenedPath(path, fd, before, platform);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Open a private regular file for reading without following a final symlink. */
export function readPrivateFile(path, encoding = 'utf8', platform = process.platform) {
  const fd = openNoFollow(path, constants.O_RDONLY, undefined, platform);
  try { return readFileSync(fd, encoding); }
  finally { closeSync(fd); }
}

/**
 * Open a private append-only file. Existing files are lstat/open/fstat identity
 * checked on Windows, where O_NOFOLLOW is unavailable; new files use exclusive
 * creation. POSIX mode checks and fchmod remain enforced on POSIX systems.
 */
export function openPrivateAppendFile(path, mode = 0o600, platform = process.platform) {
  const flags = constants.O_WRONLY | constants.O_APPEND;
  for (let attempt = 0; attempt < 3; attempt++) {
    let before;
    try { before = lstatSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before) assertPrivateRegularFile(before, 'Private append destination must be a private regular file.', platform);

    const noFollow = filesystemPrivacyCapabilities(platform).NO_FOLLOW_OPEN ? constants.O_NOFOLLOW : 0;
    let fd;
    try {
      fd = before
        ? openSync(path, flags | noFollow)
        : openSync(path, flags | constants.O_CREAT | constants.O_EXCL, mode);
    } catch (error) {
      if (['ENOENT', 'EEXIST'].includes(error.code)) continue;
      throw error;
    }

    try {
      validateOpenedPath(path, fd, before, platform);
      if (isPosix(platform) && typeof fchmodSync === 'function') fchmodSync(fd, mode);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  throw new Error('Private append destination changed repeatedly while opening; refusing access.');
}

/** Repair POSIX directory mode through an opened directory descriptor, never chmod(path). */
export function repairPrivateDirectoryMode(path, mode = 0o700, platform = process.platform) {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Private directory path must be a real directory.');
  if (!isPosix(platform)) return assertPrivateDirectory(before, undefined, platform);
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0);
  const fd = openSync(path, flags);
  try {
    const descriptor = fstatSync(fd);
    if (!descriptor.isDirectory() || !sameFile(before, descriptor)) throw new Error('Private directory changed identity while opening; refusing repair.');
    fchmodSync(fd, mode);
    const after = lstatSync(path);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(after, descriptor)) throw new Error('Private directory changed identity during repair; refusing access.');
    assertPrivateDirectory(after, 'Private directory mode repair failed.', platform);
  } finally { closeSync(fd); }
}

/** Repair POSIX regular-file mode through an O_NOFOLLOW descriptor, never chmod(path). */
export function repairPrivateRegularFileMode(path, mode = 0o600, platform = process.platform) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Private file path must be a regular file.');
  if (!isPosix(platform)) return assertPrivateRegularFile(before, undefined, platform);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const descriptor = fstatSync(fd);
    if (!descriptor.isFile() || !sameFile(before, descriptor)) throw new Error('Private file changed identity while opening; refusing repair.');
    fchmodSync(fd, mode);
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameFile(after, descriptor)) throw new Error('Private file changed identity during repair; refusing access.');
    assertPrivateRegularFile(after, 'Private file mode repair failed.', platform);
  } finally { closeSync(fd); }
}
