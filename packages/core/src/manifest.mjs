const requiredManifestKeys = [
  "name",
  "version",
  "description",
  "license",
  "aios_version",
  "requires",
  "provides",
  "permissions"
];

const requiredPermissionKeys = [
  "read",
  "write",
  "write_with_approval",
  "connections"
];

const safeNamePattern = /^[a-z0-9][a-z0-9-]*$/;

export function validateManifest(manifest) {
  const errors = [];
  const missing = requiredManifestKeys.filter((key) => manifest[key] === undefined);

  if (missing.length > 0) {
    errors.push(`Missing required key(s): ${missing.join(", ")}`);
  }

  if (manifest.name !== undefined && !safeNamePattern.test(manifest.name)) {
    errors.push("name must use lowercase letters, numbers, and hyphens only");
  }

  if (manifest.permissions !== undefined) {
    errors.push(...validatePermissions(manifest.permissions));
  }

  if (manifest.provides !== undefined) {
    errors.push(...validateProvides(manifest.provides));
  }

  if (manifest.requires !== undefined) {
    errors.push(...validateRequires(manifest.requires));
  }

  return {
    valid: errors.length === 0,
    missing,
    errors
  };
}

export function summarizePermissions(manifest) {
  const permissions = manifest.permissions || {};

  return {
    read: permissions.read || [],
    write: permissions.write || [],
    write_with_approval: permissions.write_with_approval || [],
    connections: permissions.connections || []
  };
}

function validatePermissions(permissions) {
  const errors = [];

  for (const key of requiredPermissionKeys) {
    if (!Array.isArray(permissions[key])) {
      errors.push(`permissions.${key} must be an array`);
    }
  }

  for (const key of Object.keys(permissions)) {
    if (!requiredPermissionKeys.includes(key)) {
      errors.push(`permissions.${key} is not supported`);
    }
  }

  return errors;
}

function validateProvides(provides) {
  const errors = [];
  const arrayKeys = ["skills", "memory_writers", "scheduled_tasks"];

  for (const key of arrayKeys) {
    if (provides[key] !== undefined && !Array.isArray(provides[key])) {
      errors.push(`provides.${key} must be an array`);
    }
  }

  return errors;
}

function validateRequires(requires) {
  const errors = [];
  const arrayKeys = ["connections", "context"];

  for (const key of arrayKeys) {
    if (requires[key] !== undefined && !Array.isArray(requires[key])) {
      errors.push(`requires.${key} must be an array`);
    }
  }

  return errors;
}
