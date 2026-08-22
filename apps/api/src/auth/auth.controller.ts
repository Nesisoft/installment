import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from '@installment/core';
import { CurrentUser, Public, type AuthenticatedUser } from './decorators';
import { loginSchema, otpStartSchema, otpVerifySchema, refreshSchema } from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { RateLimit } from '../common/rate-limit.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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

  /** Protected by the global JWT guard — echoes the authenticated principal. */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current authenticated principal' })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
