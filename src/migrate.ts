// 스키마 태스크 (인프라 ADR-031 · ADR-044): CD가 앱 교체 전에 1번 실행하고 끝난다. 성공 0 / 실패 1이 인프라와의 약속
// 관리자 계정으로 스키마 · 시드를 맞추고, 앱 계정에는 데이터 읽기 · 쓰기만 준다 (앱이 뚫려도 테이블 변경 · 삭제 불가)
// 배포마다 돌기 때문에 몇 번 실행해도 결과가 같아야 한다 (스키마는 IF NOT EXISTS, 데이터는 빈 DB에만)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { dbTls } from './db-tls';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 ${name}이(가) 필요합니다.`);
  return value;
}

const dbDir = path.join(__dirname, '../../db'); // dist/src 기준으로 이미지의 /app/db
const sqlFile = (name: string) => readFile(path.join(dbDir, name), 'utf8');

async function main() {
  const database = process.env.DB_NAME || 'hotel_booking';
  const appPassword = required('DB_APP_PASSWORD');
  const conn = await mysql.createConnection({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT) || 3306,
    user: required('DB_ADMIN_USER'),
    password: required('DB_ADMIN_PASSWORD'),
    database,
    charset: 'utf8mb4',
    ssl: dbTls,
    multipleStatements: true, // 이미지 안의 SQL 파일을 통째로 보냄. 밖에서 들어온 문자열은 아래 ? 자리로만 넣음
  });

  try {
    await conn.query(await sqlFile('schema.sql')); // CREATE TABLE IF NOT EXISTS: 있으면 건너뜀 (구조는 안 바꿈)
    console.log('스키마 완료');

    // 시드(화면용 기본 데이터) · 운영 규모 데이터(고객사 운영 DB에 쌓여 있다고 가정한 양)는 두 번 넣으면 중복 키로 멈추거나(예약 · 리뷰) 객실이 늘어나므로(id가 UUID()) 빈 DB에만 넣는다.
    // 한 트랜잭션이라 중간에 실패하면 통째로 취소돼 다음 실행이 처음부터 다시 넣는다
    const [[{ n }]] = await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM hotels');
    if (n === 0) {
      const started = Date.now();
      await conn.beginTransaction();
      try {
        await conn.query(await sqlFile('seed.sql'));
        await conn.query(await sqlFile('seed-volume.sql'));
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
      console.log(`시드 · 운영 규모 데이터 넣음 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
    } else {
      console.log('데이터 있음, 시드 건너뜀');
    }

    // CREATE USER IF NOT EXISTS는 계정이 있으면 비밀번호를 안 바꾸므로 ALTER USER로 금고 값에 맞춤
    await conn.query("CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY ?", [appPassword]);
    await conn.query("ALTER USER 'app'@'%' IDENTIFIED BY ?", [appPassword]);
    // FOR UPDATE는 SELECT + UPDATE면 충분. DROP · ALTER · CREATE는 주지 않음
    await conn.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ??.* TO 'app'@'%'", [database]);
    console.log('앱 계정 완료');

    // DB가 비공개라 밖에서 못 보므로, 결과 행 수를 로그로 남김
    const [counts] = await conn.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM hotels) AS hotels, (SELECT COUNT(*) FROM rooms) AS rooms,
              (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM bookings) AS bookings,
              (SELECT COUNT(*) FROM reviews) AS reviews`,
    );
    console.log('행 수', JSON.stringify(counts[0]));
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  // 에러 객체 전체를 찍으면 실행한 SQL(앱 계정 비밀번호 포함)까지 로그에 남으므로 메시지만
  console.error('스키마 태스크 실패:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
