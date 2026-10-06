import postgres from 'postgres'

const PASSWORD = encodeURIComponent('Bahraich@271801')
const REF = 'egdrnhtmclvhsfjvhyam'

const regions = ['ap-south-1', 'ap-southeast-1', 'us-east-1', 'eu-west-1', 'eu-central-1', 'ap-northeast-1', 'us-west-1']

for (const region of regions) {
  const host = `aws-0-${region}.pooler.supabase.com`
  const sql = postgres(`postgresql://postgres.${REF}:${PASSWORD}@${host}:5432/postgres`, {
    connect_timeout: 8,
    max: 1,
    idle_timeout: 5,
    prepare: false,
  })
  try {
    const r = await sql`select current_database() as db, version() as v`
    console.log(`SUCCESS ${host}: ${r[0].db} | ${r[0].v.split(',')[0]}`)
    await sql.end()
    break
  } catch (e: any) {
    console.log(`FAIL ${host}: ${String(e.message).slice(0, 120)}`)
    await sql.end()
  }
}
