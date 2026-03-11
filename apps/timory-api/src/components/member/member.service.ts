import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ObjectId } from 'mongoose';
import { Member, Members } from '../../libs/dto/member/member';
import {
	DealersInquiry,
	LoginInput,
	LoginWithGoogleInput,
	MemberInput,
	MembersInquiry,
} from '../../libs/dto/member/member.input';
import { MemberAuthType, MemberStatus, MemberType } from '../../libs/enums/member.enum';
import { Direction, Message } from '../../libs/enums/common.enum';
import { AuthService } from '../auth/auth.service';
import { MemberUpdate } from '../../libs/dto/member/member.update';
import { StatisticModifier, T } from '../../libs/types/common';
import { ViewService } from '../view/view.service';
import { ViewGroup } from '../../libs/enums/view.enum';
import { Watch } from '../../libs/dto/watch/watch';
import { LikeService } from '../like/like.service';
import { LikeInput } from '../../libs/dto/like/like.input';
import { LikeGroup } from '../../libs/enums/like.enum';
import { Follower, Following, MeFollowed } from '../../libs/dto/follow/follow';
import { lookupAuthMemberLiked } from '../../libs/config';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class MemberService {
	constructor(
		@InjectModel('Member') private readonly memberModel: Model<Member>,
		@InjectModel('Follow') private readonly followModel: Model<Follower | Following>,
		private authService: AuthService, // bu yerni yozib this.authServiceni ishlata olamiz
		private viewService: ViewService,
		private likeService: LikeService,
	) {}

	public async signup(input: MemberInput): Promise<Member> {
		if (input.memberType === MemberType.ADMIN) {
			const existingAdmin = await this.memberModel.findOne({ memberType: MemberType.ADMIN });
			if (existingAdmin) {
				throw new BadRequestException(Message.ALREADY_ADMIN);
			}
		}

		const existingEmail = await this.memberModel.findOne({ memberEmail: input.memberEmail }).exec();
		if (existingEmail) {
			throw new BadRequestException(Message.USED_MEMBER_NICK_OR_PHONE);
		}

		const hashedPassword = await this.authService.hashPassword(input.memberPassword);
		try {
			const result = await this.memberModel.create({
				memberName: input.memberName,
				memberEmail: input.memberEmail,
				memberPassword: hashedPassword,
				memberType: input.memberType,
			});
			result.accessToken = await this.authService.createToken(result);
			return result;
		} catch (err) {
			console.log('Error, Service.model:', err.message);
			throw new BadRequestException(Message.USED_MEMBER_NICK_OR_PHONE);
		}
	}

	public async login(input: LoginInput): Promise<Member> {
		const { memberName, memberPassword } = input;
		const response: Member = await this.memberModel
			.findOne({ memberName })
			.select('+memberPassword')
			.exec();

		if (!response || response.memberStatus === MemberStatus.DELETE) {
			throw new InternalServerErrorException(Message.NO_MEMBER_NICK);
		} else if (response.memberStatus === MemberStatus.BLOCK) {
			throw new InternalServerErrorException(Message.BLOCKED_USER);
		}

		const isMatch = await this.authService.comparePasswords(memberPassword, response.memberPassword);
		if (!isMatch) throw new InternalServerErrorException(Message.WRONG_PASSWORD);

		response.accessToken = await this.authService.createToken(response);

		return response;
	}

	public async loginWithGoogle(input: LoginWithGoogleInput): Promise<Member> {
		const clientId = process.env.GOOGLE_CLIENT_ID;
		if (!clientId) {
			throw new InternalServerErrorException('Google sign-in is not configured');
		}
		const client = new OAuth2Client(clientId);
		let payload: { sub: string; email?: string; name?: string; picture?: string };
		try {
			const ticket = await client.verifyIdToken({ idToken: input.googleIdToken, audience: clientId });
			payload = ticket.getPayload();
		} catch {
			throw new BadRequestException('Invalid Google token');
		}
		if (!payload?.sub) throw new BadRequestException('Invalid Google token');

		const googleId = payload.sub;
		const email = payload.email ?? null;
		const name = payload.name ?? payload.email?.split('@')[0] ?? 'User';
		const picture = payload.picture ?? null;

		let member: Member = await this.memberModel.findOne({ googleId }).exec();
		if (member) {
			if (member.memberStatus === MemberStatus.DELETE) throw new InternalServerErrorException(Message.NO_MEMBER_NICK);
			if (member.memberStatus === MemberStatus.BLOCK) throw new InternalServerErrorException(Message.BLOCKED_USER);
			member.accessToken = await this.authService.createToken(member);
			return member;
		}

		if (email) {
			member = await this.memberModel.findOne({ memberEmail: email }).exec();
			if (member) {
				if (member.memberStatus === MemberStatus.DELETE) throw new InternalServerErrorException(Message.NO_MEMBER_NICK);
				if (member.memberStatus === MemberStatus.BLOCK) throw new InternalServerErrorException(Message.BLOCKED_USER);
				await this.memberModel.findByIdAndUpdate(member._id, { $set: { googleId, memberAuthType: MemberAuthType.GOOGLE } }).exec();
				member = await this.memberModel.findById(member._id).exec();
				member.accessToken = await this.authService.createToken(member);
				return member;
			}
		}

		const memberType = input.memberType === MemberType.DEALER ? MemberType.DEALER : MemberType.USER;
		const result = await this.memberModel.create({
			googleId,
			memberEmail: email,
			memberName: name,
			memberPhoto: picture,
			memberAuthType: MemberAuthType.GOOGLE,
			memberType,
		});
		result.accessToken = await this.authService.createToken(result);
		return result;
	}

	public async updateMember(memberId: ObjectId, input: MemberUpdate): Promise<Member> {
		// faqat ruxsat berilgan maydonlarni qoldirish
		const allowedFields = ['memberPhoto', 'memberName', 'memberEmail', 'memberPhone', 'memberAddress'];
		for (const key of Object.keys(input)) {
			if (!allowedFields.includes(key)) delete input[key];
		}

		const result = await this.memberModel
			.findOneAndUpdate({ _id: memberId, memberStatus: MemberStatus.ACTIVE }, { $set: input }, { new: true })
			.select('-memberPassword') // xavfsizlik uchun
			.exec();

		if (!result) throw new InternalServerErrorException(Message.UPDATE_FAILED);

		result.accessToken = await this.authService.createToken(result);
		return result;
	}

	public async getMember(memberId: ObjectId, targetId: ObjectId): Promise<Member> {
		const search: T = {
			_id: targetId,
			memberStatus: {
				$in: [MemberStatus.ACTIVE, MemberStatus.BLOCK],
			},
		};
		const targetMember = await this.memberModel.findOne(search).lean().exec();

		if (!targetMember) throw new InternalServerErrorException(Message.NO_DATA_FOUND);

		if (memberId) {
			const viewInput = { memberId: memberId, viewRefId: targetId, viewGroup: ViewGroup.MEMBER };
			const newView = await this.viewService.recordView(viewInput);
			if (newView) {
				await this.memberModel.findByIdAndUpdate(search, { $inc: { memberViews: 1 } }, { new: true }).exec();
				targetMember.memberViews++;
			}

			const likeInput = { memberId: memberId, likeRefId: targetId, likeGroup: LikeGroup.MEMBER };
			targetMember.meLiked = await this.likeService.checkLikeExistence(likeInput);
			targetMember.meFollowed = await this.checkSubscription(memberId, targetId);
		}

		return targetMember;
	}

	private async checkSubscription(followerId: ObjectId, followingId: ObjectId): Promise<MeFollowed[]> {
		const result = await this.followModel.findOne({ followingId: followingId, followerId: followerId }).exec();
		return result ? [{ followerId: followerId, followingId: followingId, myFollowing: true }] : [];
	}

	public async getDealers(memberId: ObjectId, input: DealersInquiry): Promise<Members> {
		const { text } = input.search;
		const match: T = { memberType: MemberType.DEALER, memberStatus: MemberStatus.ACTIVE };
		const sort: T = { [input?.sort ?? 'createdAt']: input?.direction ?? Direction.DESC };

		if (text) {
			match.$or = [
				{ memberName: { $regex: new RegExp(text, 'i') } },
				{ memberEmail: { $regex: new RegExp(text, 'i') } },
			];
		}
		console.log('match:', match);

		const result = await this.memberModel
			.aggregate([
				{ $match: match },
				{ $sort: sort },
				{
					$facet: {
						list: [{ $skip: (input.page - 1) * input.limit }, { $limit: input.limit },
							lookupAuthMemberLiked(memberId),
						],
						metaCounter: [{ $count: 'total' }],
					},
				},
			])
			.exec();
		if (!result.length) throw new InternalServerErrorException(Message.NO_DATA_FOUND);
		return result[0];
	}

	public async likeTargetMember(memberId: ObjectId, likeRefId: ObjectId): Promise<Member> {
		const target: Member = await this.memberModel.findOne({ _id: likeRefId, memberStatus: MemberStatus.ACTIVE }).exec();
		if (!target) throw new InternalServerErrorException(Message.NO_DATA_FOUND);

		const input: LikeInput = {
			memberId: memberId,
			likeRefId: likeRefId,
			likeGroup: LikeGroup.MEMBER,
		};

		const modifier: number = await this.likeService.toggleLike(input);
		const result = await this.memberStatusEditor({ _id: likeRefId, targetKey: 'memberLikes', modifier: modifier });

		if (!result) throw new InternalServerErrorException(Message.SOMETHING_WENT_WRONG);
		return result;
	}

	public async getAllMembersByAdmin(input: MembersInquiry): Promise<Members> {
		const { memberStatus, memberType, text } = input.search;
		const match: T = {};
		const sort: T = { [input?.sort ?? 'createdAt']: input?.direction ?? Direction.DESC };

		if (memberStatus) match.memberStatus = memberStatus;
		if (memberType) match.memberType = memberType;
		if (text) {
			match.$or = [
				{ memberName: { $regex: new RegExp(text, 'i') } },
				{ memberEmail: { $regex: new RegExp(text, 'i') } },
			];
		}
		console.log('match:', match);

		const result = await this.memberModel
			.aggregate([
				{ $match: match },
				{ $sort: sort },
				{
					$facet: {
						list: [{ $skip: (input.page - 1) * input.limit }, { $limit: input.limit }],
						metaCounter: [{ $count: 'total' }],
					},
				},
			])
			.exec();
		if (!result.length) throw new InternalServerErrorException(Message.NO_DATA_FOUND);

		return result[0];
	}

	public async updateMemberByAdmin(input: MemberUpdate): Promise<Member> {
		if (!input._id) throw new BadRequestException(Message.BAD_REQUEST);
		const allowedFields = ['memberPhoto', 'memberName', 'memberEmail', 'memberPhone', 'memberAddress'];
		const update: T = {};
		for (const key of allowedFields) {
			if (input[key] !== undefined) update[key] = input[key];
		}
		const result: Member = await this.memberModel
			.findOneAndUpdate({ _id: input._id }, { $set: update }, { new: true })
			.select('-memberPassword')
			.exec();
		if (!result) throw new InternalServerErrorException(Message.UPDATE_FAILED);
		return result;
	}

	// FOR WATCH SERVICE
	public async getMemberById(memberId: string | ObjectId): Promise<Member> {
		try {
			const member = await this.memberModel.findById(memberId).lean().exec();
			if (!member) throw new BadRequestException(Message.NO_MEMBER_FOUND);
			return member;
		} catch (err) {
			console.log('Error in getMemberById:', err.message);
			throw new BadRequestException(Message.NO_MEMBER_FOUND);
		}
	}

	public async findDealersByIds(ids: string[]): Promise<Member[]> {
		try {
			if (!ids || !ids.length) return [];

			const dealers = await this.memberModel
				.find({
					_id: { $in: ids },
					memberType: MemberType.DEALER,
					memberStatus: MemberStatus.ACTIVE,
				})
				.select('_id memberName memberPhone')
				.lean()
				.exec();

			return dealers;
		} catch (err) {
			console.log('Error in findDealersByIds:', err.message);
			throw new BadRequestException('Not found Dealer Data!');
		}
	}

	public async memberStatusEditor(input: StatisticModifier): Promise<Member> {
		const { _id, targetKey, modifier } = input;
		console.log('MemberService.memberStatusEditor:', {
			_id: String(_id),
			targetKey,
			modifier,
		});
		return await this.memberModel
			.findByIdAndUpdate(
				_id,
				{
					$inc: { [targetKey]: modifier },
				},
				{ new: true },
			)
			.exec();
	}
}
