// Integration fixtures must not contact the public release service.
process.env.BOTSPACE_NO_UPDATE_CHECK ??= "1";
