import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from '@installment/core';
import { CurrentUser, Public, type AuthenticatedUser } from './decorators';
import { actorOf } from './current-actor';
import {
  loginSchema,
  changePasswordSchema,
  otpStartSchema,
  otpVerifySchema,
  refreshSchema,
  signupStartSchema,
  signupVerifySchema,
  signupVerifyCodeSchema,
  signupCompleteSchema,
  merchantSignupStartSchema,
  merchantSignupVerifyCodeSchema,
  merchantSignupCompleteSchema,
} from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { RateLimit } from '../common/rate-limit.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  // By explicit token: the test build ignores `emitDecoratorMetadata`.
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  // Credential stuffing is the threat: a wrong password must stay cheap for us
  // and expensive for them. Bucketed with the OTP routes so an attacker cannot
  // switch login methods to refresh their allowance.
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiZodBody(loginSchema)
  @HttpCode(200)
  @ApiOperation({ summary: 'Email + password login (staff / merchant)' })
  @ApiBody({ schema: { example: { email: 'admin@installment.local', password: 'secret123' } } })
  login(@Body() body: unknown) {
    return this.auth.passwordLogin(body);
  }

  @Public()
  @Post('customer/otp/start')
  // Every call sends a real SMS: unbounded, this is both a bill and a way to
  // bomb someone's phone. Tighter than the rest of the auth family.
  @RateLimit({ limit: 5, windowSeconds: 300, bucket: 'auth' })
  @ApiZodBody(otpStartSchema)
  @HttpCode(202)
  @ApiOperation({ summary: 'Begin customer phone-OTP login (sends a code)' })
  @ApiBody({ schema: { example: { phone: '0244123456' } } })
  otpStart(@Body() body: unknown) {
    return this.auth.customerOtpStart(body);
  }

  @Public()
  @Post('customer/otp/verify')
  // A 6-digit code is guessable given enough attempts. OtpService already burns
  // the code after 5 tries; this stops an attacker restarting the flow to keep
  // guessing.
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiZodBody(otpVerifySchema)
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete customer OTP login, returns tokens' })
  @ApiBody({ schema: { example: { phone: '0244123456', code: '123456' } } })
  otpVerify(@Body() body: unknown) {
    return this.auth.customerOtpVerify(body);
  }

  /**
   * Self-signup, step 1. Verify-then-create: this sends a code and writes
   * nothing, so an abandoned or automated attempt leaves no customer record
   * behind and cannot squat a phone number.
   */
  @Public()
  @Post('customer/signup/start')
  @ApiZodBody(signupStartSchema)
  @HttpCode(202)
  @RateLimit({ limit: 5, windowSeconds: 300, bucket: 'auth' })
  @ApiOperation({ summary: 'Begin customer self-signup (sends a code)' })
  @ApiBody({ schema: { example: { phone: '0244123456' } } })
  signupStart(@Body() body: unknown) {
    return this.auth.customerSignupStart(body);
  }

  /**
   * Self-signup, step 2. Proves the code and hands back a short-lived ticket,
   * so the app can show the registration form only once the phone is confirmed
   * — rather than making someone fill it in and then telling them the code was
   * wrong. Still creates nothing.
   */
  @Public()
  @Post('customer/signup/verify-code')
  @ApiZodBody(signupVerifyCodeSchema)
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiOperation({ summary: 'Verify a signup code, returns a short-lived signup ticket' })
  @ApiBody({ schema: { example: { phone: '0244123456', code: '123456' } } })
  signupVerifyCode(@Body() body: unknown) {
    return this.auth.customerSignupVerifyCode(body);
  }

  /**
   * Self-signup, step 3: the ticket from step 2 plus the profile. The phone
   * comes from the ticket, never the body, so a caller cannot verify one number
   * and register another.
   */
  @Public()
  @Post('customer/signup/complete')
  @ApiZodBody(signupCompleteSchema)
  @HttpCode(201)
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiOperation({ summary: 'Create the account from a signup ticket, returns tokens' })
  @ApiBody({
    schema: {
      example: {
        signupToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        first_name: 'Ama',
        last_name: 'Mensah',
        email: 'ama@example.com',
        consents: { data_processing: true, credit_scoring: true, marketing: false },
      },
    },
  })
  signupComplete(@Body() body: unknown) {
    return this.auth.customerSignupComplete(body);
  }

  // --- Merchant self-signup -------------------------------------------------
  //
  // Same three steps as the customer flow above, on the same OTP machinery,
  // because a Ghanaian trader has a phone and this system has no email
  // delivery. Everything it creates is inert: the merchant lands `pending_kyc`
  // and the shopfront `draft`, so a seller can do all their own setup and none
  // of it is visible or purchasable until an admin activates them.

  /** Merchant signup, step 1: send a code to the number the business answers on. */
  @Public()
  @Post('merchant/signup/start')
  @ApiZodBody(merchantSignupStartSchema)
  @HttpCode(202)
  @RateLimit({ limit: 5, windowSeconds: 300, bucket: 'auth' })
  @ApiOperation({ summary: 'Begin merchant self-signup (sends a code)' })
  @ApiBody({ schema: { example: { phone: '0244123456' } } })
  merchantSignupStart(@Body() body: unknown) {
    return this.auth.merchantSignupStart(body);
  }

  /** Merchant signup, step 2: prove the code before the business form is shown. */
  @Public()
  @Post('merchant/signup/verify-code')
  @ApiZodBody(merchantSignupVerifyCodeSchema)
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiOperation({ summary: 'Verify a merchant signup code, returns a signup ticket' })
  @ApiBody({ schema: { example: { phone: '0244123456', code: '123456' } } })
  merchantSignupVerifyCode(@Body() body: unknown) {
    return this.auth.merchantSignupVerifyCode(body);
  }

  /**
   * Merchant signup, step 3: the ticket plus the business. Creates the
   * merchant, its login and its shopfront, and returns tokens.
   *
   * The phone comes from the ticket, never the body, so a caller cannot verify
   * one number and register another. Note what the body cannot carry: MDR,
   * reserve and business model come from the platform defaults, and the slug is
   * derived from the shop name — a merchant setting their own take-rate at
   * signup would be the business model handed over in a request body.
   */
  @Public()
  @Post('merchant/signup/complete')
  @ApiZodBody(merchantSignupCompleteSchema)
  @HttpCode(201)
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiOperation({ summary: 'Create the merchant from a signup ticket, returns tokens' })
  @ApiBody({
    schema: {
      example: {
        signupToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        business_name: 'Auntie Akos Kente',
        legal_name: 'Akosua Ventures Ltd',
        email: 'akosua@auntieakos.gh',
        password: 'a-strong-passphrase',
        tin: 'C0012345678',
      },
    },
  })
  merchantSignupComplete(@Body() body: unknown) {
    return this.auth.merchantSignupComplete(body);
  }

  /** Self-signup, step 2: the code plus the profile and consents to create. */
  @Public()
  @Post('customer/signup/verify')
  @ApiZodBody(signupVerifySchema)
  @HttpCode(201)
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiOperation({ summary: 'Complete customer self-signup, returns tokens' })
  @ApiBody({
    schema: {
      example: {
        phone: '0244123456',
        code: '123456',
        first_name: 'Ama',
        last_name: 'Mensah',
        email: 'ama@example.com',
        consents: { data_processing: true, credit_scoring: true, marketing: false },
      },
    },
  })
  signupVerify(@Body() body: unknown) {
    return this.auth.customerSignupVerify(body);
  }

  @Public()
  @Post('refresh')
  @RateLimit({ limit: 30, windowSeconds: 300, bucket: 'auth' })
  @ApiZodBody(refreshSchema)
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate access + refresh tokens' })
  @ApiBody({ schema: { example: { refreshToken: 'eyJhbGciOi...' } } })
  refresh(@Body() body: unknown) {
    return this.auth.refresh(body);
  }

  /**
   * The signed-in owner of a password login replaces it. Needs a session but no
   * permission, which is what lets a member of staff on a temporary password —
   * who holds no permissions — do the one thing they must.
   */
  @Post('password')
  @ApiBearerAuth()
  // A stolen session could otherwise guess at the current password here, where
  // login's own limit does not reach. Same bucket as login, for that reason.
  @RateLimit({ limit: 10, windowSeconds: 300, bucket: 'auth' })
  @ApiZodBody(changePasswordSchema)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change your own password (staff / merchant)',
    description:
      'Asks for the current password. Answers with a fresh session: this device stays signed in, ' +
      'and every other session for the account stops renewing. 400 for a wrong current password.',
  })
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.auth.changePassword(user.id, body, actorOf(user));
  }

  /** Protected by the global JWT guard — echoes the authenticated principal. */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current authenticated principal' })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
