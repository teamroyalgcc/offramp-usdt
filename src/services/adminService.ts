import supabase from '../utils/supabase.js';
import bcrypt from 'bcryptjs';

// Admins never see login codes or PIN hashes (a 6-digit PIN hash is brute-forceable).
const stripSecrets = ({ email_otp, email_otp_expires, transaction_pin_hash, password_hash, ...u }: any) => u;
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import tronService from './tronService.js';

import configService from './configService.js';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../utils/db.js';
import depositWorker from '../workers/depositWorker.js';
import { formatUsdt } from '../tron/usdt.js';
import wsService from './wsService.js';

const usdt = (raw: unknown) => (raw == null ? null : formatUsdt(BigInt(String(raw))));

/** Plain-language explanation and allowed action for a failed transfer to treasury. */
function explainFailedSweep(lastError: string | null) {
  const e = lastError ?? '';
  if (e.startsWith('cost_cap')) {
    return {
      explanation: `Moving this deposit would cost ${e.split(':')[1]} TRX, above your safety limit (SWEEP_MAX_COST_TRX = ${config.sweep.maxCostTrx}). The money is safe in the deposit address. Check that the Netts balance is topped up, or raise the limit on the server, then click Retry.`,
      canRetry: true,
    };
  }
  if (e.startsWith('no_energy')) {
    return {
      explanation: `Could not get energy to move this deposit (${e.slice(10, 200)}). Top up the Netts balance and the operating wallet (TRX), then click Retry. The money is safe in the deposit address.`,
      canRetry: true,
    };
  }
  if (e === 'unexpected_receipt') {
    return { explanation: 'The transfer went through but did not match what we expected. Do NOT retry. Contact the developer.', canRetry: false };
  }
  return { explanation: `The transfer did not complete after several tries (${e || 'unknown reason'}). The money is safe in the deposit address. Click Retry.`, canRetry: true };
}

export class AdminService {
  private static instance: AdminService;

  private constructor() {}

  public static getInstance(): AdminService {
    if (!AdminService.instance) {
      AdminService.instance = new AdminService();
    }
    return AdminService.instance;
  }

  async login(username: string, password: string) {
    try {
      const { data: admin, error } = await supabase
        .from('admins')
        .select('*')
        .eq('username', username)
        .maybeSingle();
      
      if (error) {
        console.error('Supabase error during admin login:', error);
        throw new Error('Database connection error');
      }
      
      if (!admin) {
        throw new Error('Invalid credentials');
      }

      const isValid = await bcrypt.compare(password, admin.password_hash);
      if (!isValid) {
        // Log if it's not a bcrypt hash to help debug
        if (!admin.password_hash.startsWith('$2')) {
          console.warn(`Admin ${username} has an unhashed password. Please update it using bcrypt.`);
        }
        throw new Error('Invalid credentials');
      }

      const token = jwt.sign(
        { id: admin.id, username: admin.username, role: admin.role },
        config.jwtSecret,
        { expiresIn: '8h' }
      );

      return {
        token,
        admin: { id: admin.id, username: admin.username, role: admin.role }
      };
    } catch (err: any) {
      console.error(`Admin login failed for ${username}:`, err.message);
      throw err;
    }
  }

  async getAdminMe(adminId: string) {
    const { data, error } = await supabase
      .from('admins')
      .select('id, username, role')
      .eq('id', adminId)
      .single();
    if (error) throw error;
    return data;
  }

  async updateAdminCredentials(adminId: string, username?: string, password?: string) {
    const updates: any = {};
    if (username) updates.username = username;
    if (password) {
      updates.password_hash = await bcrypt.hash(password, 10);
    }
    
    if (Object.keys(updates).length === 0) return { success: false, message: 'No updates provided' };

    const { data, error } = await supabase
      .from('admins')
      .update(updates)
      .eq('id', adminId)
      .select('id, username, role')
      .single();

    if (error) throw error;
    await this.logAction(adminId, 'UPDATE_CREDENTIALS', 'admin', adminId, { updatedFields: Object.keys(updates) });
    return { success: true, admin: data };
  }

  async createAdmin(username: string, password: string, role: string, requesterAdminId: string) {
    // Check requester role
    const { data: requester } = await supabase
      .from('admins')
      .select('role')
      .eq('id', requesterAdminId)
      .single();
    
    if (!requester || requester.role !== 'superadmin') {
      throw new Error('Unauthorized: Only super admins can create new admins');
    }

    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('admins')
      .insert({
        id: uuidv4(),
        username,
        password_hash,
        role: role || 'admin',
        created_at: new Date().toISOString()
      })
      .select('id, username, role')
      .single();

    if (error) {
      if (error.code === '23505') throw new Error('Username already exists');
      throw error;
    }

    await this.logAction(requesterAdminId, 'CREATE_ADMIN', 'admin', data.id, { username, role });
    return { success: true, admin: data };
  }

  async listAdmins(requesterAdminId: string) {
    const { data: requester } = await supabase
      .from('admins')
      .select('role')
      .eq('id', requesterAdminId)
      .single();
    
    if (!requester || requester.role !== 'superadmin') {
      throw new Error('Permission denied');
    }

    const { data, error } = await supabase
      .from('admins')
      .select('id, username, role, created_at')
      .neq('id', requesterAdminId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    return data;
  }

  async updateOtherAdmin(requesterAdminId: string, targetAdminId: string, updates: { username?: string, password?: string }) {
    const { data: requester } = await supabase
      .from('admins')
      .select('role')
      .eq('id', requesterAdminId)
      .single();
    
    if (!requester || requester.role !== 'superadmin') {
      throw new Error('Permission denied');
    }

    const updatePayload: any = {};
    if (updates.username) updatePayload.username = updates.username;
    if (updates.password) {
      updatePayload.password_hash = await bcrypt.hash(updates.password, 10);
    }

    if (Object.keys(updatePayload).length === 0) throw new Error('No updates provided');

    const { data, error } = await supabase
      .from('admins')
      .update(updatePayload)
      .eq('id', targetAdminId)
      .select('id, username, role')
      .single();
    
    if (error) throw error;
    await this.logAction(requesterAdminId, 'SUPERADMIN_UPDATE_ADMIN', 'admin', targetAdminId, { fields: Object.keys(updatePayload) });
    return { success: true, admin: data };
  }

  async deleteAdmin(requesterAdminId: string, targetAdminId: string) {
    const { data: requester } = await supabase
      .from('admins')
      .select('role')
      .eq('id', requesterAdminId)
      .single();
    
    if (!requester || requester.role !== 'superadmin') {
      throw new Error('Permission denied');
    }

    const { error } = await supabase
      .from('admins')
      .delete()
      .eq('id', targetAdminId);
    
    if (error) throw error;
    await this.logAction(requesterAdminId, 'SUPERADMIN_DELETE_ADMIN', 'admin', targetAdminId);
    return { success: true };
  }

  async getDashboardData() {
    const treasuryAddress = config.treasuryAddress;
    const treasuryBalance = await tronService.getTreasuryBalance(treasuryAddress);

    const [
      { count: pendingKYC },
      { count: pendingOrders },
      { count: pendingWithdrawals }
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('kyc_status', 'pending'),
      supabase.from('exchange_orders').select('*', { count: 'exact', head: true }).eq('status', 'PROCESSING'),
      supabase.from('usdt_withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'pending')
    ]);
    const health = await this.getDepositHealth();

    return {
      treasury: {
        address: treasuryAddress,
        ...treasuryBalance
      },
      stats: {
        pendingKYC: pendingKYC || 0,
        pendingOrders: pendingOrders || 0,
        pendingWithdrawals: pendingWithdrawals || 0,
        depositItemsNeedingAttention: health.items.filter((i) => i.action || i.severity === 'high').length,
      }
    };
  }

  async getKycList() {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .neq('kyc_status', 'not_submitted')
      .order('created_at', { ascending: false });
    if (error) throw error;
    // KYC photos live in a private bucket; hand the admin a link that expires in 1 hour.
    const marker = '/KYC-DOCUMENTS/';
    return Promise.all((data ?? []).map(stripSecrets).map(async (u: any) => {
      const url: string = u.aadhaar_photo_url || '';
      if (!url.includes(marker)) return u;
      const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length).split('?')[0]);
      const { data: signed } = await supabase.storage.from('KYC-DOCUMENTS').createSignedUrl(path, 3600);
      return { ...u, aadhaar_photo_url: signed?.signedUrl ?? null };
    }));
  }

  async approveKyc(userId: string, adminId: string) {
    const { error } = await supabase.from('users').update({
      kyc_status: 'approved',
      kyc_verified_at: new Date().toISOString(),
      kyc_rejection_reason: null
    }).eq('id', userId);
    if (error) throw error;
    await this.logAction(adminId, 'KYC_APPROVE', 'user', userId);
    return { success: true };
  }

  async rejectKyc(userId: string, reason: string, adminId: string) {
    const { error } = await supabase.from('users').update({
      kyc_status: 'rejected',
      kyc_rejection_reason: reason || 'Admin Rejected'
    }).eq('id', userId);
    if (error) throw error;
    await this.logAction(adminId, 'KYC_REJECT', 'user', userId, { reason });
    return { success: true };
  }

  /** Recent USDT deposits with user and treasury-transfer status. */
  async getDeposits() {
    const { rows } = await query(
      `SELECT d.id, d.tx_id, d.amount_raw, d.status, d.block_ts, d.from_address,
              d.user_id, u.email, u.account_holder_name, a.tron_address, a.id AS deposit_address_id,
              CASE
                WHEN d.status = 'review' THEN 'on_hold'
                WHEN EXISTS (SELECT 1 FROM sweeps s WHERE s.deposit_address_id = d.deposit_address_id
                              AND s.status = 'confirmed' AND s.amount_raw > 0 AND s.confirmed_at >= d.created_at) THEN 'done'
                WHEN EXISTS (SELECT 1 FROM sweeps s WHERE s.deposit_address_id = d.deposit_address_id
                              AND s.status = 'failed' AND s.updated_at >= d.created_at) THEN 'failed'
                ELSE 'in_progress'
              END AS treasury_transfer
         FROM deposits d
         JOIN deposit_addresses a ON a.id = d.deposit_address_id
         LEFT JOIN users u ON u.id = d.user_id
        ORDER BY d.created_at DESC LIMIT 200`,
    );
    return rows.map((r: any) => ({
      id: r.id,
      txId: r.tx_id,
      user: { id: r.user_id, email: r.email, name: r.account_holder_name },
      fromAddress: r.from_address,
      depositAddress: r.tron_address,
      amount: usdt(r.amount_raw),
      status: r.status === 'credited' ? 'credited' : 'on_hold',
      treasuryTransfer: r.treasury_transfer,
      receivedAt: r.block_ts,
    }));
  }

  /**
   * Everything about deposits that needs a human, in plain language, with the
   * one action the admin can take for each item (if any).
   */
  async getDepositHealth() {
    const [failed, held, slow, audit] = await Promise.all([
      query(`SELECT s.id, s.last_error, s.updated_at, a.tron_address, a.user_id, u.email
               FROM sweeps s JOIN deposit_addresses a ON a.id = s.deposit_address_id LEFT JOIN users u ON u.id = a.user_id
              WHERE s.status = 'failed' ORDER BY s.updated_at DESC`),
      query(`SELECT d.id, d.amount_raw, d.block_ts, d.user_id, u.email
               FROM deposits d LEFT JOIN users u ON u.id = d.user_id
              WHERE d.status = 'review' ORDER BY d.created_at`),
      // Small balances wait up to 24 h on purpose, so only flag sweeps past that.
      query(`SELECT s.id, s.created_at, a.tron_address FROM sweeps s JOIN deposit_addresses a ON a.id = s.deposit_address_id
              WHERE s.status IN ('pending', 'submitted') AND s.created_at < NOW() - interval '25 hours'`),
      query(`SELECT created_at, addresses_checked, issues FROM audit_reports ORDER BY created_at DESC LIMIT 1`),
    ]);

    const items: any[] = [];
    for (const s of failed.rows) {
      const { explanation, canRetry } = explainFailedSweep(s.last_error);
      items.push({
        id: s.id, severity: 'high', title: 'Transfer to treasury failed', explanation,
        user: s.email, address: s.tron_address, at: s.updated_at,
        action: canRetry ? { label: 'Retry transfer', method: 'POST', path: `/api/admin/sweeps/${s.id}/retry` } : null,
      });
    }
    for (const d of held.rows) {
      items.push({
        id: d.id, severity: 'medium', title: 'Deposit below minimum (not credited yet)',
        explanation: `The user sent ${usdt(d.amount_raw)} USDT, below the minimum of ${config.sweep.minDepositUsdt} USDT. ` +
          `Click "Credit anyway" to add it to their balance, or contact the user first.`,
        user: d.email, at: d.block_ts,
        action: { label: 'Credit anyway', method: 'POST', path: `/api/admin/deposits/${d.id}/credit` },
      });
    }
    for (const s of slow.rows) {
      items.push({
        id: s.id, severity: 'low', title: 'Transfer to treasury is taking longer than usual',
        explanation: 'The system keeps retrying automatically. No action needed unless this stays here for several hours.',
        address: s.tron_address, at: s.created_at, action: null,
      });
    }
    const last = audit.rows[0];
    for (const i of last?.issues ?? []) {
      if (i.kind === 'unrecorded_funds') {
        items.push({
          id: `${i.depositAddressId}:unrecorded`, severity: 'medium', title: 'USDT received but not recorded',
          explanation: `${i.amount} USDT is sitting in a user's deposit address but was not credited, most likely because it was sent while the deposit screen was closed. Click "Check again" to find and credit it.`,
          address: i.address, at: last.created_at,
          action: { label: 'Check again', method: 'POST', path: `/api/admin/deposit-addresses/${i.depositAddressId}/scan` },
        });
      } else if (i.kind === 'balance_short') {
        items.push({
          id: `${i.depositAddressId}:short`, severity: 'high', title: 'Deposit address has less USDT than expected',
          explanation: `${i.amount} USDT is missing compared with our records and no transfer to treasury is running. Contact the developer immediately.`,
          address: i.address, at: last.created_at, action: null,
        });
      }
    }

    return {
      status: items.some((i) => i.severity !== 'low') ? 'attention' : 'ok',
      lastCheck: last ? { at: last.created_at, addressesChecked: last.addresses_checked } : null,
      items,
    };
  }

  async retrySweep(sweepId: string, adminId: string) {
    const failed = await query(`SELECT last_error FROM sweeps WHERE id = $1 AND status = 'failed'`, [sweepId]);
    if (!failed.rows[0]) throw new Error('This transfer is not in a failed state');
    if (!explainFailedSweep(failed.rows[0].last_error).canRetry) throw new Error('This transfer must not be retried. Contact the developer.');
    try {
      await query(
        `UPDATE sweeps SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'failed'`,
        [sweepId],
      );
    } catch (e: any) {
      if (e.code === '23505') throw new Error('Another transfer for this address is already running');
      throw e;
    }
    await this.logAction(adminId, 'SWEEP_RETRY', 'sweep', sweepId);
    return { success: true };
  }

  async creditHeldDeposit(depositId: string, adminId: string) {
    const { rows } = await query(`SELECT credit_held_deposit($1) AS r`, [depositId]);
    await this.logAction(adminId, 'DEPOSIT_CREDIT_HELD', 'deposit', depositId, rows[0].r);
    return { success: true, ...rows[0].r };
  }

  /** Rescans one address, then re-runs the balance check so the list reflects the result. */
  async scanDepositAddress(depositAddressId: string, adminId: string) {
    const scan = await depositWorker.scanNow(depositAddressId);
    // ponytail: re-checks every address; fine for hundreds, scope to one address if it gets slow.
    await depositWorker.runAudit('manual');
    await this.logAction(adminId, 'DEPOSIT_ADDRESS_SCAN', 'deposit_address', depositAddressId, scan);
    return scan;
  }

  async runDepositAudit(adminId: string) {
    const result = await depositWorker.runAudit('manual');
    await this.logAction(adminId, 'DEPOSIT_AUDIT_RUN', 'audit_reports', 'manual', { issues: result.issues.length });
    return result;
  }

  async freezeAccount(userId: string, frozen: boolean, adminId: string) {
    const { error } = await supabase
      .from('users')
      .update({ is_frozen: frozen, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw error;
    
    await this.logAction(adminId, frozen ? 'FREEZE_USER' : 'UNFREEZE_USER', 'users', userId);
    return { success: true };
  }

  async getOrders() {
    const { data, error } = await supabase
      .from('exchange_orders')
      .select('*, users(email, account_holder_name), bank_accounts(*)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  /**
   * The admin pays INR to the user's bank by hand, then completes the order here:
   * SUCCESS = paid (note = bank reference / UTR, required); FAILED or REFUNDED =
   * not paid, USDT goes back to the user's balance (note = reason).
   */
  async updateOrderStatus(orderId: string, status: string, note: string, adminId: string) {
    const s = status.toUpperCase();
    if (s !== 'SUCCESS' && s !== 'FAILED' && s !== 'REFUNDED') {
      throw new Error('Orders can only be marked as paid (SUCCESS) or refunded (FAILED/REFUNDED)');
    }
    const paid = s === 'SUCCESS';
    if (!note.trim()) throw new Error(paid ? 'Enter the bank reference / UTR of the INR transfer' : 'Enter a reason for the refund');
    const { rows } = await query(`SELECT complete_exchange_order($1, $2, $3) AS r`, [orderId, paid, note.trim()]);
    await this.logAction(adminId, paid ? 'ORDER_PAID' : 'ORDER_REFUNDED', 'order', orderId, { note });
    wsService.sendToUser(rows[0].r.user_id, 'ORDER_UPDATED', { orderId, status: rows[0].r.status });
    return { success: true, status: rows[0].r.status };
  }

  async updateRateSettings(input: { spreadPercent?: number; manualRate?: number | null }, adminId: string) {
    const changes: Record<string, unknown> = {};
    if (input.spreadPercent !== undefined) changes.exchange_spread_percent = input.spreadPercent;
    if (input.manualRate !== undefined) {
      changes.manual_rate_inr = input.manualRate;
      changes.manual_rate_expires_at = input.manualRate === null ? null : new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    }
    if (!Object.keys(changes).length) throw new Error('Nothing to update');
    const result = await configService.update(changes as any);
    await this.logAction(adminId, 'UPDATE_RATE_SETTINGS', 'system_settings', 'rate', changes);
    return result;
  }

  async getUsers() {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(stripSecrets);
  }

  async freezeUser(userId: string, frozen: boolean, adminId: string) {
    return this.freezeAccount(userId, frozen, adminId);
  }

  async getAuditLogs() {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  private async logAction(adminId: string, action: string, entityType: string, entityId: string, metadata: any = {}) {
    await supabase.from('audit_logs').insert({
      user_id: adminId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      new_values: metadata,
      created_at: new Date().toISOString()
    });
  }
}

export default AdminService.getInstance();
