import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from '@installment/core';
import { CurrentUser, Public, type AuthenticatedUser } from './decorators';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.auth.passwordLogin(body);
  }

  @Public()
  @Post('customer/otp/start')
  @HttpCode(202)
  otpStart(@Body() body: unknown) {
    return this.auth.customerOtpStart(body);
  }

  @Public()
  @Post('customer/otp/verify')
  @HttpCode(200)
  otpVerify(@Body() body: unknown) {
    return this.auth.customerOtpVerify(body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    return this.auth.refresh(body);
  }

  /** Protected by the global JWT guard — echoes the authenticated principal. */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
