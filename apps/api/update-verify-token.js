const { PrismaClient } = require('@prisma/client');
const { encrypt } = require('./dist/src/common/security/encryption.util');

const prisma = new PrismaClient();

async function main() {
  const config = await prisma.whatsapp_config.findFirst();
  if (!config) {
    console.log('No whatsapp_config found');
    return;
  }
  
  const encryptedToken = encrypt('test');
  await prisma.whatsapp_config.update({
    where: { id: config.id },
    data: { verify_token: encryptedToken }
  });
  
  console.log('Updated verify_token to "test" for config:', config.id);
}

main().catch(console.error).finally(() => prisma.$disconnect());
