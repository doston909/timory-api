import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ObjectId } from 'mongoose';
import { Watch, Watches } from '../../libs/dto/watch/watch';
import { MemberService } from '../member/member.service';
import {
	AllWatchesInquiry,
	DealerWatchesInquiry,
	OrdinaryInquiry,
	WatchesInquiry,
	WatchInput,
} from '../../libs/dto/watch/watch.input';
import { Direction, Message } from '../../libs/enums/common.enum';
import { MemberType } from '../../libs/enums/member.enum';
import { ViewService } from '../view/view.service';
import { StatisticModifier, T } from '../../libs/types/common';
import { WatchStatus } from '../../libs/enums/watch.enum';
import { ViewGroup } from '../../libs/enums/view.enum';
import moment from 'moment';
import { WatchUpdate } from '../../libs/dto/watch/watch.update';
import { lookupAuthMemberLiked, lookupMember, shapeIntoMongoObjectId } from '../../libs/config';
import { LikeService } from '../like/like.service';
import { LikeInput } from '../../libs/dto/like/like.input';
import { LikeGroup } from '../../libs/enums/like.enum';
@Injectable()
export class WatchService {
	constructor(
		@InjectModel('Watch') private readonly watchModel: Model<Watch>,
		private memberService: MemberService,
		private viewService: ViewService,
		private likeService: LikeService,
	) {}

	/** Faqat DEALER soat yarata oladi */
	public async createWatch(input: WatchInput): Promise<Watch> {
		try {
			const dealer = await this.memberService.getMemberById(input.memberId);
			if (!dealer || dealer.memberType !== MemberType.DEALER)
				throw new BadRequestException('Faqat DEALER soat yarata oladi.');

			const result = await this.watchModel.create({
				...input,
				memberId: dealer._id,
				dealerId: [dealer._id],
				watchStatus: WatchStatus.ACTIVE,
			});

			await this.memberService.memberStatusEditor({
				_id: dealer._id,
				targetKey: 'memberWatches',
				modifier: 1,
			});

			return result;
		} catch (err) {
			console.log('Error, createWatch:', err.message);
			throw new BadRequestException('Soat yaratishda xatolik yuz berdi.');
		}
	}

	public async getWatch(memberId: ObjectId, watchId: ObjectId): Promise<Watch> {
		const targetWatch: Watch = await this.watchModel.findOne({ _id: watchId }).lean().exec();
		if (!targetWatch) throw new InternalServerErrorException(Message.NO_DATA_FOUND);

		if (memberId) {
			const viewInput = { memberId: memberId, viewRefId: watchId, viewGroup: ViewGroup.WATCH };
			const newView = await this.viewService.recordView(viewInput);
			if (newView) {
				await this.watchStatusEditor({ _id: watchId, targetKey: 'watchViews', modifier: 1 });
				targetWatch.watchViews++;
			}
			// meLiked
			const likeInput = { memberId: memberId, likeRefId: watchId, likeGroup: LikeGroup.WATCH };
			targetWatch.meLiked = await this.likeService.checkLikeExistence(likeInput);
		}

		try {
			targetWatch.memberData = await this.memberService.getMember(null, targetWatch.memberId);
		} catch {
			targetWatch.memberData = null;
		}
		return targetWatch;
	}

	public async watchStatusEditor(input: StatisticModifier): Promise<Watch> {
		const { _id, targetKey, modifier } = input;
		console.log('WatchService.watchStatusEditor:', {
			_id: String(_id),
			targetKey,
			modifier,
		});
		return await this.watchModel
			.findByIdAndUpdate(
				_id,
				{ $inc: { [targetKey]: modifier } },
				{
					new: true,
				},
			)
			.exec();
	}

	public async updateWatch(memberId: ObjectId, input: WatchUpdate): Promise<Watch> {
		let { watchStatus } = input;
		const search: T = {
			_id: input._id,
			memberId: memberId,
			watchStatus: WatchStatus.ACTIVE,
		};

		if (watchStatus === WatchStatus.SOLD) input.soldAt = moment().toDate();
		else if (watchStatus === WatchStatus.DELETE) input.deletedAt = moment().toDate();

		const result = await this.watchModel
			.findByIdAndUpdate(search, input, {
				new: true,
			})
			.exec();
		if (!result) throw new InternalServerErrorException(Message.UPDATE_FAILED);

		if (input.soldAt || input.deletedAt) {
			await this.memberService.memberStatusEditor({
				_id: memberId,
				targetKey: 'memberWatches',
				modifier: -1,
			});
		}

		return result;
	}

	public async getWatches(memberId: ObjectId, input: WatchesInquiry): Promise<Watches> {
		const match: T = { watchStatus: WatchStatus.ACTIVE };
		const sort: T = { [input?.sort ?? 'createdAt']: input?.direction ?? Direction.DESC };

		this.shapeMatchQuery(match, input);
		console.log('match:', match);

		const result = await this.watchModel
			.aggregate([
				{ $match: match },
				{ $sort: sort },
				{
					$facet: {
						list: [
							{ $skip: (input.page - 1) * input.limit },
							{ $limit: input.limit },
							// meLiked
							lookupAuthMemberLiked(memberId),
							lookupMember,
							{ $unwind: { path: '$memberData', preserveNullAndEmptyArrays: true } },
						],
						metaCounter: [{ $count: 'total' }],
					},
				},
			])
			.exec();

		const out = result[0];
		if (!out) return { list: [], metaCounter: [{ total: 0 }] };
		if (!out.metaCounter?.length) out.metaCounter = [{ total: 0 }];
		return out;
	}

	private shapeMatchQuery(match: T, input: WatchesInquiry): void {
		const {
			brandId,
			dealerId,
			locationList,
			typeList,
			statusList,
			pricesRange,
			sizesRange,
			periodsRange,
			options,
			text,
			watchLimitedEdition,
		} = input.search;

		if (brandId) match.memberId = shapeIntoMongoObjectId(brandId);
		if (dealerId) {
			match.dealerId = { $in: [shapeIntoMongoObjectId(dealerId)] };
		}

		if (locationList?.length) match.watchLocation = { $in: locationList };

		if (typeList?.length) match.watchType = { $in: typeList };

		if (statusList?.length) match.watchStatus = { $in: statusList };

		if (pricesRange)
			match.watchPrice = {
				$gte: pricesRange.start,
				$lte: pricesRange.end,
			};

		if (sizesRange)
			match.watchSize = {
				$gte: sizesRange.start,
				$lte: sizesRange.end,
			};

		if (periodsRange)
			match.createdAt = {
				$gte: periodsRange.start,
				$lte: periodsRange.end,
			};

		if (text && text.trim().length > 0)
			match.$or = [
				{ watchModelName: { $regex: new RegExp(text, 'i') } },
				{ watchBrand: { $regex: new RegExp(text, 'i') } },
				{ watchDescription: { $regex: new RegExp(text, 'i') } },
			];

		if (watchLimitedEdition !== undefined)
			match.watchLimitedEdition = watchLimitedEdition;

		if (options && options.length > 0) {
			match.$and = options.map((opt) => ({
				[`options.${opt}`]: true,
			}));
		}
	}

	public async getFavorites(memberId: ObjectId, input: OrdinaryInquiry): Promise<Watches> {
		return await this.likeService.getFavoriteWatches(memberId, input);
	}

	public async getVisited(memberId: ObjectId, input: OrdinaryInquiry): Promise<Watches> {
		return await this.viewService.getVisitedWatches(memberId, input);
	}

	public async getDealerWatches(memberId: ObjectId, input: DealerWatchesInquiry): Promise<Watches> {
		const { watchStatus, text } = input.search;

		// Dealer o‘z soatlarini ko‘radi: ACTIVE, SOLD, DELETE (mypage da hammasi ko‘rinsin)
		const match: T = {
			memberId: memberId,
			watchStatus: watchStatus ?? { $in: [WatchStatus.ACTIVE, WatchStatus.SOLD, WatchStatus.DELETE] },
		};

		if (text) {
			match.$or = [
				{ watchModelName: { $regex: new RegExp(text, 'i') } },
				{ watchDescription: { $regex: new RegExp(text, 'i') } },
			];
		}

		const sort: T = {
			[input?.sort ?? 'createdAt']: input?.direction ?? Direction.DESC,
		};

		const result = await this.watchModel
			.aggregate([
				{ $match: match },
				{ $sort: sort },
				{
					$facet: {
						list: [
							{ $skip: (input.page - 1) * input.limit },
							{ $limit: input.limit },
							{
								$lookup: {
									from: 'members',
									localField: 'memberId',
									foreignField: '_id',
									as: 'memberData',
								},
							},
							{ $unwind: '$memberData' },
						],
						metaCounter: [{ $count: 'total' }],
					},
				},
			])
			.exec();

		if (!result.length) {
			throw new InternalServerErrorException(Message.NO_DATA_FOUND);
		}

		return result[0];
	}

	public async likeTargetWatch(memberId: ObjectId, likeRefId: ObjectId): Promise<Watch> {
		const target: Watch = await this.watchModel.findOne({ _id: likeRefId, watchStatus: WatchStatus.ACTIVE }).exec();
		if (!target) throw new InternalServerErrorException(Message.NO_DATA_FOUND);

		const input: LikeInput = {
			memberId: memberId,
			likeRefId: likeRefId,
			likeGroup: LikeGroup.WATCH,
		};

		console.log('WatchService.likeTargetWatch - request:', {
			memberId: String(memberId),
			likeRefId: String(likeRefId),
		});

		const modifier: number = await this.likeService.toggleLike(input);
		const result = await this.watchStatusEditor({ _id: likeRefId, targetKey: 'watchLikes', modifier: modifier });

		if (!result) throw new InternalServerErrorException(Message.SOMETHING_WENT_WRONG);
		return result;
	}

	public async getAllWatchesByAdmin(input: AllWatchesInquiry): Promise<Watches> {
		const { watchStatus, watchLocationList, watchTypeList } = input.search;
		const match: T = {};
		const sort: T = { [input?.sort ?? 'createdAt']: input?.direction ?? Direction.DESC };

		if (watchStatus) match.watchStatus = watchStatus;
		if (watchLocationList) match.watchLocation = { $in: watchLocationList };
		if (watchTypeList?.length) match.watchType = { $in: watchTypeList };

		const result = await this.watchModel
			.aggregate([
				{ $match: match },
				{ $sort: sort },
				{
					$facet: {
						list: [
							{ $skip: (input.page - 1) * input.limit },
							{ $limit: input.limit },
							lookupMember, //  memberData: [memberDataValue]
							{ $unwind: '$memberData' }, //  memberData: memberDataValue
						],
						metaCounter: [{ $count: 'total' }],
					},
				},
			])
			.exec();

		if (!result.length) throw new InternalServerErrorException(Message.NO_DATA_FOUND);

		return result[0];
	}

	public async updateWatchByAdmin(input: WatchUpdate): Promise<Watch> {
		let { watchStatus, soldAt, deletedAt } = input;

		const search: T = {
			_id: input._id,
			watchStatus: WatchStatus.ACTIVE,
		};

		if (watchStatus === WatchStatus.SOLD) soldAt = moment().toDate();
		else if (watchStatus === WatchStatus.DELETE) deletedAt = moment().toDate();

		const result = await this.watchModel.findByIdAndUpdate(search, input, { new: true }).exec();

		if (!result) throw new InternalServerErrorException(Message.UPDATE_FAILED);

		if (soldAt || deletedAt) {
			await this.memberService.memberStatusEditor({
				_id: result.memberId,
				targetKey: 'memberWatches',
				modifier: -1,
			});
		}

		return result;
	}

	public async removeWatchByAdmin(watchId: ObjectId): Promise<Watch> {
		const search: T = { _id: watchId, watchStatus: WatchStatus.DELETE };
		const result = await this.watchModel.findByIdAndDelete(search).exec();
		if (!result) throw new InternalServerErrorException(Message.REMOVE_FAILED);

		return result;
	}

	/** Dealer o‘z soatini butunlay o‘chiradi (REMOVE) */
	public async removeWatch(memberId: ObjectId, watchId: ObjectId): Promise<Watch> {
		const doc = await this.watchModel.findOne({ _id: watchId, memberId: memberId }).exec();
		if (!doc) throw new InternalServerErrorException(Message.REMOVE_FAILED);
		if (doc.watchStatus !== WatchStatus.DELETE) {
			await this.memberService.memberStatusEditor({
				_id: memberId,
				targetKey: 'memberWatches',
				modifier: -1,
			});
		}
		const result = await this.watchModel.findByIdAndDelete(watchId).exec();
		if (!result) throw new InternalServerErrorException(Message.REMOVE_FAILED);
		return result;
	}
}
