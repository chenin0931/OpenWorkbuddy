import { safeStorage } from 'electron'

export class SecretStore {
  async encrypt(value: string): Promise<Buffer> {
    if (!value) throw new Error('Secret 不能为空')
    if (typeof safeStorage.encryptStringAsync === 'function') return safeStorage.encryptStringAsync(value)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    return safeStorage.encryptString(value)
  }

  async decrypt(value: Buffer): Promise<string> {
    if (typeof safeStorage.decryptStringAsync === 'function') {
      const decrypted = await safeStorage.decryptStringAsync(value)
      return decrypted.result
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    return safeStorage.decryptString(value)
  }

  async available(): Promise<boolean> {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') return safeStorage.isAsyncEncryptionAvailable()
    return safeStorage.isEncryptionAvailable()
  }
}
