# Admin Auth API Documentation

Base URL: `/api` (prefix varies by environment)

All protected endpoints require:
```
Authorization: Bearer <sToken>
```

---

## Endpoints

### 1. Admin Login

**POST** `/auth/admin/login`

**Request Body**
```json
{
  "sEmail": "admin@example.com",
  "sPassword": "YourPass@123"
}
```

| Field       | Type   | Required | Description          |
|-------------|--------|----------|----------------------|
| `sEmail`    | string | Yes      | Valid email address  |
| `sPassword` | string | Yes      | Account password     |

**Response — 200 OK**
```json
{
  "message": "Admin Login successfully",
  "data": {
    "_id": "64abc123...",
    "sToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "sUserName": "superadmin",
    "eAdminType": "SUPER",
    "sProfilePicUrl": "https://s3.amazonaws.com/..."
  }
}
```

**Error Responses**
| Status | Message                      | Reason                  |
|--------|------------------------------|-------------------------|
| 404    | `admin not found`            | No account with that email |
| 400    | `Email or Password is invalid` | Wrong password         |
| 422    | `Unprocessable entity`       | Validation failed       |

**Notes**
- JWT token is valid for **1 day**.
- Token is stored in `admin.sToken`; logging in again invalidates the previous token.

---

### 2. Admin Logout

**POST** `/auth/admin/logout`

**Headers**
```
Authorization: Bearer <sToken>
```

**Response — 200 OK**
```json
{
  "message": "Logout successfully",
  "data": {
    "sToken": null
  }
}
```

**Notes**
- Clears the stored token from the database, invalidating all active sessions.

---

### 3. Forgot Password (Request Reset Email)

**POST** `/auth/admin/password/reset`

**Request Body**
```json
{
  "sEmail": "admin@example.com"
}
```

| Field    | Type   | Required | Description         |
|----------|--------|----------|---------------------|
| `sEmail` | string | Yes      | Registered email    |

**Response — 200 OK**
```json
{
  "message": "Email Sent successfully"
}
```

**Error Responses**
| Status | Message                 | Reason                              |
|--------|-------------------------|-------------------------------------|
| 404    | `admin not found`       | No account with that email          |
| 429    | `too_many_request`      | More than 5 requests within 20 min  |
| 500    | `Email Sent error`      | Mail delivery failure               |

**Notes**
- A password reset link is sent to the provided email.
- Link format: `{WEB_URL}/reset-password?token={resetToken}`
- The reset token expires in **5 minutes**.

---

### 4. Validate Reset Token

**GET** `/auth/admin/:token/reset`

**URL Parameters**
| Param   | Type   | Description                    |
|---------|--------|--------------------------------|
| `token` | string | Token received in reset email  |

**Response — 200 OK (valid token)**
```json
{
  "message": "token valid"
}
```

**Response — 200 OK (invalid/expired token)**
```json
{
  "message": "token expire is invalid"
}
```

---

### 5. Reset Password

**POST** `/auth/admin/:token/reset`

**URL Parameters**
| Param   | Type   | Description                    |
|---------|--------|--------------------------------|
| `token` | string | Token received in reset email  |

**Request Body**
```json
{
  "sPassword": "NewPass@123",
  "sConfirmPassword": "NewPass@123"
}
```

| Field              | Type   | Required | Description          |
|--------------------|--------|----------|----------------------|
| `sPassword`        | string | Yes      | New password         |
| `sConfirmPassword` | string | Yes      | Must match `sPassword` |

**Password Rules**
- 8–15 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 digit
- At least 1 special character: `# ? ! @ $ % ^ & * -`

**Response — 200 OK**
```json
{
  "message": "Password updated"
}
```

**Error Responses**
| Status | Message                              | Reason                        |
|--------|--------------------------------------|-------------------------------|
| 400    | `Token expired`                      | Reset token has expired       |
| 400    | `Password not matched (bad request)` | Passwords do not match        |
| 422    | `Unprocessable entity`               | Validation failed             |

---

### 6. Get Admin Profile

**GET** `/admin/profile`

**Headers**
```
Authorization: Bearer <sToken>
```

**Response — 200 OK**
```json
{
  "message": "Data found",
  "data": {
    "_id": "64abc123...",
    "sEmail": "admin@example.com",
    "sUserName": "superadmin",
    "eAdminType": "SUPER",
    "sProfilePicUrl": "https://s3.amazonaws.com/..."
  }
}
```

---

### 7. Update Admin Profile

**PATCH** `/admin/profile/update`

**Headers**
```
Authorization: Bearer <sToken>
Content-Type: multipart/form-data
```

**Request Body (form-data)**
| Field       | Type   | Required | Description                      |
|-------------|--------|----------|----------------------------------|
| `sUserName` | string | Yes      | New display name                 |
| `image`     | file   | No       | Profile picture (uploaded to S3) |

**Response — 200 OK**
```json
{
  "message": "Admin Profile updated"
}
```

**Error Responses**
| Status | Message                    | Reason                     |
|--------|----------------------------|----------------------------|
| 400    | `User Name not found`      | `sUserName` missing        |
| 400    | `User Name is invalid`     | `sUserName` format invalid |
| 404    | `user not found`           | Admin not found by token   |

---

### 8. Change Password

**PATCH** `/admin/password/update`

**Headers**
```
Authorization: Bearer <sToken>
```

**Request Body**
```json
{
  "sOldPassword": "OldPass@123",
  "sNewPassword": "NewPass@456",
  "sConfirmPassword": "NewPass@456"
}
```

| Field              | Type   | Required | Description                      |
|--------------------|--------|----------|----------------------------------|
| `sOldPassword`     | string | Yes      | Current password                 |
| `sNewPassword`     | string | Yes      | New password (must meet rules)   |
| `sConfirmPassword` | string | Yes      | Must match `sNewPassword`        |

**Password Rules** — same as [Reset Password](#5-reset-password)

**Response — 200 OK**
```json
{
  "message": "Password updated"
}
```

**Error Responses**
| Status | Message                                          | Reason                            |
|--------|--------------------------------------------------|-----------------------------------|
| 400    | `sOldPassword not found`                         | Field missing                     |
| 400    | `Password is invalid`                            | Old password incorrect            |
| 400    | `New-Password is invalid`                        | New password format invalid       |
| 400    | `Old password and new password is same (bad request)` | New == old password          |
| 400    | `Password not matched (bad request)`             | New and confirm don't match       |

---

## JWT Token

**Payload structure:**
```json
{
  "_id": "mongodb_admin_id",
  "sName": "admin_username",
  "sEmail": "admin@example.com",
  "eAdminType": "SUPER | SUB",
  "iat": 1710000000,
  "exp": 1710086400
}
```

- Signed with `JWT_SECRET` (env variable)
- Expires after `JWT_VALIDITY` — default **1 day**
- Validated by checking both JWT signature **and** the stored `sToken` in the database

---

## Admin Types

| Value   | Description         |
|---------|---------------------|
| `SUPER` | Super Administrator |
| `SUB`   | Sub Administrator   |
