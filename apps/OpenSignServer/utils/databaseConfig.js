export function databaseUri(env = process.env) {
  const primary = env.DATABASE_URI?.trim();
  const secondary = env.MONGODB_URI?.trim();
  if (primary && secondary && primary !== secondary) {
    throw new Error(
      'DATABASE_URI und MONGODB_URI widersprechen sich. Bitte nur eine Datenbank konfigurieren.'
    );
  }
  const uri = primary || secondary;
  if (!uri) throw new Error('DATABASE_URI oder MONGODB_URI muss ausdrücklich gesetzt sein.');
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri))
    throw new Error('Die Datenbankadresse ist keine MongoDB-URI.');
  return uri;
}
