import type { ApprovalGate, Redactor, SecretProvider } from '@myagents/protocol'
export { AgentEnvironmentIsolator as DefaultEnvironmentIsolator } from '../runtime/environment-isolator'

export class DefaultSecretProvider implements SecretProvider {
  async resolve(ref: string): Promise<string | null> {
    if (!ref) return null
    if (ref.startsWith('env:')) {
      return process.env[ref.slice(4)] ?? null
    }
    // v0.1a stores direct reference; v0.2+ swaps in encrypted Vault implementation
    return ref
  }
}

export class BasicRedactor implements Redactor {
  private readonly secrets = new Set<string>()

  registerSecret(value: string): void {
    if (value && value.length >= 6) this.secrets.add(value)
  }

  scrub(text: string): string {
    let out = text
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.replaceAll(secret, '•••')
    }
    return out
  }
}

export class NoopApprovalGate implements ApprovalGate {
  async checkToolCall(): Promise<{ decision: 'allow' }> {
    return { decision: 'allow' }
  }
}
