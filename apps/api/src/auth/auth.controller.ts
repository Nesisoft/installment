import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from '@installment/core';
import { CurrentUser, Public, type AuthenticatedUser } from './decorators';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email + password login (staff / merchant)' })
  @ApiBody({ schema: { example: { email: 'admin@installment.local', password: 'secret123' } } })
  login(@Body() body: unknown) {
    return this.auth.passwordLogin(body);
  }

  @Public()
  @Post('customer/otp/start')
  @HttpCode(202)
  @ApiOperation({ summary: 'Begin customer phone-OTP login (sends a code)' })
  @ApiBody({ schema: { example: { phone: '0244123456' } } })
  otpStart(@Body() body: unknown) {
    return this.auth.customerOtpStart(body);
  }

  @Public()
  @Post('customer/otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete customer OTP login, returns tokens' })
  @ApiBody({ schema: { example: { phone: '0244123456', code: '123456' } } })
  otpVerify(@Body() body: unknown) {
    return this.auth.customerOtpVerify(body);
  }

  @Public()
  @Post('refresh')
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
