import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPrivateDirectory,
  assertPrivateRegularFile,
  filesystemPrivacyCapabilities,
  openPrivateAppendFile,
  readPrivateFile,
  repairPrivateDirectoryMode,
  repairPrivateRegularFileMode,
} from '../../../../src/agent/infrastructure/persistence/filesystem-privacy.mjs';

const directoryStat = mode => ({ mode, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false });
const fileStat = mode => ({ mode, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false });

test('filesystem privacy capabilities disclose Windows ACL and POSIX mode limits truthfully', () => {
  const windows = filesystemPrivacyCapabilities('win32');
  assert.equal(windows.POSIX_MODE_ENFORCEMENT, false);
  assert.equal(windows.WINDOWS_ACL_ENVIRONMENT, true);
  assert.equal(windows.WINDOWS_ACL_VERIFIED, false);
  assert.equal(windows.POSIX_PRIVATE_DIRECTORY_CREATION, false);
  assert.equal(windows.POSIX_PRIVATE_FILE_CREATION, false);
  const posix = filesystemPrivacyCapabilities('linux');
  assert.equal(posix.POSIX_MODE_ENFORCEMENT, true);
  assert.equal(posix.POSIX_PRIVATE_DIRECTORY_CREATION, true);
  assert.equal(posix.POSIX_PRIVATE_FILE_CREATION, true);
});

test('POSIX private-path assertions retain restrictive directory and file mode checks', () => {
  assert.doesNotThrow(() => assertPrivateDirectory(directoryStat(0o40700), 'private', 'linux'));
  assert.throws(() => assertPrivateDirectory(directoryStat(0o40755), 'private', 'linux'), /private/);
  assert.doesNotThrow(() => assertPrivateRegularFile(fileStat(0o100600), 'private', 'linux'));
  assert.throws(() => assertPrivateRegularFile(fileStat(0o100644), 'private', 'linux'), /private/);
});

test('Windows branch ignores POSIX mode bits but still rejects symlinks and wrong object types', () => {
  assert.doesNotThrow(() => assertPrivateDirectory(directoryStat(0o40777), 'private', 'win32'));
  assert.doesNotThrow(() => assertPrivateRegularFile(fileStat(0o100666), 'private', 'win32'));
  assert.throws(() => assertPrivateDirectory({ ...directoryStat(0o40777), isSymbolicLink: () => true }, 'private', 'win32'), /private/);
  assert.throws(() => assertPrivateRegularFile(directoryStat(0o40777), 'private', 'win32'), /private/);
});

test('simulated Windows ACL fallback verifies file identity without claiming ACL privacy', () => {
  const root = mkdtempSync(join(tmpdir(), 'filesystem-privacy-win32-'));
  try {
    const file = join(root, 'ledger.jsonl');
    writeFileSync(file, 'before\n');
    const fd = openPrivateAppendFile(file, 0o600, 'win32');
    try { writeFileSync(fd, 'after\n'); } finally { closeSync(fd); }
    assert.equal(readPrivateFile(file, 'utf8', 'win32'), 'before\nafter\n');
    const link = join(root, 'linked.jsonl');
    symlinkSync(file, link);
    assert.throws(() => readPrivateFile(link, 'utf8', 'win32'), /symlink|regular file|private/);
    assert.throws(() => openPrivateAppendFile(link, 0o600, 'win32'), /symlink|regular file|private/);
    assert.equal(filesystemPrivacyCapabilities('win32').WINDOWS_ACL_VERIFIED, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function withOpenHook(t, target, hook, phase = 'after') {
  const original = fs.openSync;
  fs.openSync = function (path, flags, ...args) {
    if (path === target && phase === 'before') hook();
    const fd = original.call(this, path, flags, ...args);
    if (path === target && phase === 'after') hook(fd);
    return fd;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = original; syncBuiltinESMExports(); });
}

test('identity validation preserves full-width Windows file identifiers', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'filesystem-privacy-bigint-id-'));
  const path = join(root, 'ledger.jsonl');
  writeFileSync(path, 'content\n');
  const fileId = { dev: 7n, ino: 9_007_199_254_741_111n, mode: 0n, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  fs.lstatSync = (candidate, ...args) => candidate === path ? fileId : originalLstat(candidate, ...args);
  fs.fstatSync = (fd, ...args) => fileId;
  syncBuiltinESMExports();
  t.after(() => {
    fs.lstatSync = originalLstat;
    fs.fstatSync = originalFstat;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(readPrivateFile(path, 'utf8', 'win32'), 'content\n');
});

test('read rejects a path that becomes a symlink after a missing pre-stat', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'filesystem-privacy-missing-swap-'));
  const target = join(root, 'target.jsonl');
  const path = join(root, 'ledger.jsonl');
  writeFileSync(target, 'private target\n');
  withOpenHook(t, path, () => symlinkSync(target, path), 'before');
  try { assert.throws(() => readPrivateFile(path, 'utf8', 'win32'), /changed|symlink|regular file|private/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('read rejects a path whose identity changes after open', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'filesystem-privacy-identity-swap-'));
  const path = join(root, 'ledger.jsonl');
  const moved = join(root, 'opened-ledger.jsonl');
  writeFileSync(path, 'opened object\n');
  withOpenHook(t, path, () => { renameSync(path, moved); writeFileSync(path, 'replacement object\n'); });
  try { assert.throws(() => readPrivateFile(path, 'utf8', 'win32'), /changed identity/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('append rejects an existing destination replaced after open', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'filesystem-privacy-append-swap-'));
  const path = join(root, 'ledger.jsonl');
  const moved = join(root, 'opened-ledger.jsonl');
  writeFileSync(path, 'opened object\n');
  withOpenHook(t, path, () => { renameSync(path, moved); writeFileSync(path, 'replacement object\n'); });
  try { assert.throws(() => openPrivateAppendFile(path, 0o600, 'win32'), /changed identity/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('POSIX repair helpers restore restrictive modes through verified descriptors', (t) => {
  if (!filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) {
    t.skip('POSIX descriptor permission repair is not available on this platform.');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'filesystem-privacy-repair-'));
  try {
    const dir = join(root, 'private');
    const file = join(root, 'private.jsonl');
    mkdirSync(dir, { mode: 0o777 });
    writeFileSync(file, 'secret\n', { mode: 0o666 });
    chmodSync(dir, 0o777);
    chmodSync(file, 0o666);
    repairPrivateDirectoryMode(dir, 0o700, 'linux');
    repairPrivateRegularFileMode(file, 0o600, 'linux');
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    const linkedDir = join(root, 'linked-dir');
    symlinkSync(dir, linkedDir, 'dir');
    assert.throws(() => repairPrivateDirectoryMode(linkedDir, 0o700, 'linux'), /real directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('private append and read helpers preserve content and reject symlink destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'filesystem-privacy-'));
  try {
    const file = join(root, 'ledger.jsonl');
    const fd = openPrivateAppendFile(file);
    try { writeFileSync(fd, 'first\n'); } finally { closeSync(fd); }
    const appendFd = openPrivateAppendFile(file);
    try { writeFileSync(appendFd, 'second\n'); } finally { closeSync(appendFd); }
    assert.equal(readPrivateFile(file), 'first\nsecond\n');
    assertPrivateRegularFile(lstatSync(file));
    const link = join(root, 'linked.jsonl');
    symlinkSync(file, link);
    assert.throws(() => readPrivateFile(link), /symlink|regular file|private/);
    assert.throws(() => openPrivateAppendFile(link), /symlink|regular file|private/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

