import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { ERROR_CODES } from '../../constants/errors';
import { BudgetService } from './budget.service';

@Controller('api/trips/:tripId/budgets')
export class BudgetController {
  constructor(private readonly service: BudgetService) {}

  // 读取不做登录限制，方便行程内查看；写入（新增/修改）仅限行程发起者
  @Get()
  list(@Param('tripId') tripId: string) {
    return this.service.list(this.parseTripId(tripId));
  }

  @Post()
  @UseGuards(JwtGuard)
  upsert(
    @Req() req: { user: { userId: number } },
    @Param('tripId') tripId: string,
    @Body() body: { category?: string; planned?: number; spent?: number }
  ) {
    return this.service.upsert(this.parseTripId(tripId), req.user.userId, body.category, body.planned, body.spent);
  }

  @Patch(':id')
  @UseGuards(JwtGuard)
  update(
    @Req() req: { user: { userId: number } },
    @Param('tripId') tripId: string,
    @Param('id') id: string,
    @Body() body: { planned?: number; spent?: number }
  ) {
    return this.service.update(this.parseTripId(tripId), req.user.userId, this.parseBudgetId(id), body);
  }

  private parseTripId(value: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '行程 ID 非法');
    }
    return id;
  }

  private parseBudgetId(value: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '预算记录 ID 非法');
    }
    return id;
  }
}
