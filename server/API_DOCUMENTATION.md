# Offramp USDT Backend – API Documentation

Base URL: `http://<host>:<port>`

All routes below are prefixed with the path shown (e.g. `/api/auth/login`).

---

## Health Check

Api documentation

Url : `/health`  
Method : `GET`  
Payload : `none`  
Result data :  
`{ status : "success", timestamp : "<ISO string>", env : "development" | "production" | "test" }`

---

## Authentication – User

### Send OTP

Api documentation

Url : `/api/auth/send-otp`  
Method : `POST`  
Payload :  
`{ accountNumber : "12345678" }`  
Result data :  
`{ message : "OTP sent successfully" }`  

Notes:
- `accountNumber` is treated as the user’s bank account number (and also phone identifier for SMS).

---

### Signup

Api documentation

Url : `/api/auth/signup`  
Method : `POST`  
Payload :  
```json
{
  "accountHolderName": "Abi",
  "accountNumber": "12345678",
  "ifscCode": "SBIN0000000",
  "otp": "123456",
  "referralCode": "ABC123"
}
```  
Result data :  
```json
{
  "user": {
    "id": "uuid",
    "account_holder_name": "Abi",
    "account_number": "12345678",
    "ifsc_code": "SBIN0000000",
    "referral_code": "MYREF1",
    "kyc_status": "not_submitted",
    "email": "12345678@internal.local",
    "...": "other user fields"
  },
  "token": "jwt_token_here"
}
```  

Notes:
- `otp` must match the OTP sent to `accountNumber`.
- Fails with 400 if OTP invalid or user already exists.

---

### Login

Api documentation

Url : `/api/auth/login`  
Method : `POST`  
Payload :  
```json
{
  "accountNumber": "12345678",
  "otp": "123456"
}
```  
Result data :  
```json
{
  "user": { /* same shape as signup user */ },
  "token": "jwt_token_here"
}
```  

Notes:
- Fails with 400 if OTP invalid or user does not exist.

---

### Get Current User

Api documentation

Url : `/api/auth/me`  
Method : `GET`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
`{ /* full user record from users table */ }`

---

### Guest Login (Development Only)

Api documentation

Url : `/api/auth/guest-login`  
Method : `POST`  
Payload :  
`{ "referralCode": "ABC123" }` // optional  
Result data :  
```json
{
  "user": { /* guest user created in users table */ },
  "token": "jwt_token_here"
}
```  

Notes:
- Only allowed when `NODE_ENV=development`. In other environments returns 403.

---

## Wallet

### Get Balance

Api documentation

Url : `/api/wallet/balance`  
Method : `GET`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
```json
{
  "available_balance": 100.0,
  "locked_balance": 0.0,
  "settled_balance": 0.0
}
```  

---

### Generate Deposit Address

Api documentation

Url : `/api/wallet/generate-address`  
Method : `POST`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
```json
{
  "tron_address": "Txxxxx...",
  "expires_at": "2026-02-20T12:00:00.000Z",
  "created_at": "2026-02-20T11:30:00.000Z"
}
```  

Notes:
- Generates or reuses a TRON USDT deposit address tied to the user, with expiry.

---

## Exchange (USDT → INR)

### Get Live Rate

Api documentation

Url : `/api/exchange/rate`  
Method : `GET`  
Payload : `none`  
Result data :  
```json
{
  "rate": 82.5
}
```  

Notes:
- `rate` is the current INR per USDT, including configured spreads.

---

### Create Exchange Order

Api documentation

Url : `/api/exchange/create-order`  
Method : `POST`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload (using saved bank account):  
```json
{
  "usdtAmount": 100.0,
  "bankAccountId": "uuid-of-bank-account"
}
```  

Payload (using one-time bank details):  
```json
{
  "usdtAmount": 100.0,
  "bankDetails": {
    "account_number": "1234567890",
    "ifsc": "SBIN0000000",
    "account_holder_name": "Abi"
  }
}
```  

Result data :  
- HTTP 201  
- Body:  
`{ /* exchange order object: id, status, usdtAmount, inrAmount, bank details, timestamps */ }`

Notes:
- Returns 400 if request body fails validation.

---

### List User Exchange Orders

Api documentation

Url : `/api/exchange/orders`  
Method : `GET`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
```json
[
  { /* order 1 */ },
  { /* order 2 */ }
]
```  

---

## KYC

### Submit KYC

Api documentation

Url : `/api/kyc/verify-kyc`  
Method : `POST`  
Headers :  
- `Authorization: Bearer <jwt_token>`  
- `Content-Type: multipart/form-data`  

Payload (form-data):  
- `aadhaar_image`: file (image)  
- Additional text fields as required by KYC form (e.g. name, aadhaar_number, dob).  

Result data :  
- HTTP 200 on success  
- Body:  
`{ /* KYC submission result, e.g. status and message */ }`  

Notes:
- On validation error returns 400 with error message.

---

### Get KYC Status

Api documentation

Url : `/api/kyc/status`  
Method : `GET`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
```json
{
  "kyc_status": "not_submitted" | "pending" | "approved" | "rejected",
  "reason": "optional rejection reason"
}
```  

---

## Referral

### Get Referral Stats

Api documentation

Url : `/api/referral/stats`  
Method : `GET`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
```json
{
  "code": "ABC123",
  "points": 50,
  "totalReferrals": 5
}
```  

---

## Real-Time Streams (SSE)

### Real-Time Balance

Api documentation

Url : `/api/stream/balance`  
Method : `GET`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
- HTTP 200, connection kept open  
- Server-Sent Events of type `balance`:
```text
event: balance
data: {"available_balance": 100.0, "locked_balance": 0.0, "settled_balance": 0.0}
```  

---

### Real-Time Orders

Api documentation

Url : `/api/stream/orders`  
Method : `GET`  
Headers : `Authorization: Bearer <jwt_token>`  
Payload : `none`  
Result data :  
- HTTP 200, connection kept open  
- Server-Sent Events of type `orders`:
```text
event: orders
data: [ { /* latest orders */ } ]
```  

---

## Admin APIs

All admin APIs require a valid admin JWT:

Headers : `Authorization: Bearer <admin_jwt_token>`

### Admin Login

Api documentation

Url : `/api/admin/login`  
Method : `POST`  
Payload :  
```json
{
  "username": "admin",
  "password": "secret"
}
```  
Result data :  
```json
{
  "admin": {
    "id": "uuid",
    "username": "admin",
    "role": "superadmin"
  },
  "token": "admin_jwt_token"
}
```  

---

### Admin Dashboard Data

Api documentation

Url : `/api/admin/dashboard`  
Method : `GET`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`{ /* aggregated metrics: totals, volumes, counts */ }`

---

### List KYC Submissions

Api documentation

Url : `/api/admin/kyc`  
Method : `GET`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`[ { /* KYC record */ }, ... ]`

---

### Approve KYC

Api documentation

Url : `/api/admin/kyc/:id/approve`  
Method : `POST`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`{ /* result of approval */ }`

---

### Reject KYC

Api documentation

Url : `/api/admin/kyc/:id/reject`  
Method : `POST`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload :  
```json
{
  "reason": "KYC document unreadable"
}
```  
Result data :  
`{ /* result of rejection */ }`

---

### List Deposits

Api documentation

Url : `/api/admin/deposits`  
Method : `GET`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`[ { /* deposit record */ }, ... ]`

---

### Approve Deposit

Api documentation

Url : `/api/admin/deposits/:txHash/approve`  
Method : `POST`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`{ /* result of deposit approval */ }`

---

### Manual Credit

Api documentation

Url : `/api/admin/manual-credit`  
Method : `POST`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload :  
```json
{
  "userId": "uuid-of-user",
  "amount": 100.0,
  "txHash": "reference-or-tx-hash"
}
```  
Result data :  
`{ /* result of manual credit */ }`

---

### List All Orders

Api documentation

Url : `/api/admin/orders`  
Method : `GET`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`[ { /* order */ }, ... ]`

---

### Update Order Status

Api documentation

Url : `/api/admin/orders/:id/status`  
Method : `POST`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload :  
```json
{
  "status": "completed",
  "note": "Paid via IMPS"
}
```  
Result data :  
`{ /* result of status update */ }`

---

### List Users

Api documentation

Url : `/api/admin/users`  
Method : `GET`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`[ { /* user */ }, ... ]`

---

### Freeze / Unfreeze User

Api documentation

Url : `/api/admin/users/:id/freeze`  
Method : `POST`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload :  
```json
{
  "frozen": true
}
```  
Result data :  
`{ /* result of freeze/unfreeze */ }`

---

### Audit Logs

Api documentation

Url : `/api/admin/audit`  
Method : `GET`  
Headers : `Authorization: Bearer <admin_jwt_token>`  
Payload : `none`  
Result data :  
`[ { /* audit log entry */ }, ... ]`

## Payouts

The system currently uses a manual payout process. Admin must manually verify and complete payout orders.

---

## Admin API