import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  UploadSessionCreateDto,
  UploadSessionResponseDto,
  UploadSessionSignPartsDto,
  UploadSessionSignedPartsDto,
} from 'src/dtos/upload-session.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { UploadSessionService } from 'src/services/upload-session.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets/upload-sessions')
export class UploadSessionController {
  constructor(private service: UploadSessionService) {}

  @Post()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Create a direct upload session', history: new HistoryBuilder().added('v3').beta('v3') })
  createUploadSession(@Auth() auth: AuthDto, @Body() dto: UploadSessionCreateDto): Promise<UploadSessionResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Get a direct upload session and its uploaded parts',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  getUploadSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<UploadSessionResponseDto> {
    return this.service.status(auth, id);
  }

  @Post(':id/parts')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Sign a batch of direct upload parts', history: new HistoryBuilder().added('v3').beta('v3') })
  signUploadSessionParts(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UploadSessionSignPartsDto,
  ): Promise<UploadSessionSignedPartsDto> {
    return this.service.signParts(auth, id, dto.partNumbers);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Request asynchronous direct upload completion',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  completeUploadSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<UploadSessionResponseDto> {
    return this.service.complete(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Abort an uncommitted direct upload session',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  abortUploadSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.abort(auth, id);
  }
}
