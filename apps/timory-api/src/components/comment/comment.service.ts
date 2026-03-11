import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { MemberService } from '../member/member.service';
import { WatchService } from '../watch/watch.service';
import { BoardArticleService } from '../board-article/board-article.service';
import { Direction, Message } from '../../libs/enums/common.enum';
import { CommentGroup, CommentStatus } from '../../libs/enums/comment.enum';
import { Model, ObjectId } from 'mongoose';
import { CommentInput, CommentsInquiry } from '../../libs/dto/comment/comment.input';
import { CommentUpdate } from '../../libs/dto/comment/comment.update';
import { Comment, Comments } from '../../libs/dto/comment/comment';
import { T } from '../../libs/types/common';
import { lookupMember } from '../../libs/config';

@Injectable()
export class CommentService {
	constructor(
		@InjectModel('Comment') private readonly commentModel: Model<Comment>,
		private readonly memberService: MemberService,
		private readonly watchService: WatchService,
		private readonly boardArticleService: BoardArticleService,
	) {}

	public async createComment(memberId: ObjectId, input: CommentInput): Promise<Comment> {
		input.memberId = memberId;

		let result = null;
		try {
			console.log('CommentService.createComment - input:', {
				memberId: String(memberId),
				commentGroup: input.commentGroup,
				commentRefId: String(input.commentRefId),
			});
			result = await this.commentModel.create(input);
			console.log('CommentService.createComment - created:', {
				_id: String(result._id),
				commentGroup: result.commentGroup,
				commentRefId: String(result.commentRefId),
				createdAt: result.createdAt,
			});
		} catch (err) {
			console.log('Error, Service.model:', err.message);
			throw new BadRequestException(Message.CREATE_FAILED);
		}

		switch (input.commentGroup) {
			case CommentGroup.WATCH:
				await this.watchService.watchStatusEditor({
					_id: input.commentRefId,
					targetKey: 'watchComments',
					modifier: 1,
				});
				break;
			case CommentGroup.ARTICLE:
				await this.boardArticleService.boardArticleStatusEditor({
					_id: input.commentRefId,
					targetKey: 'articleComments',
					modifier: 1,
				});
				break;
			case CommentGroup.MEMBER:
				await this.memberService.memberStatusEditor({
					_id: input.commentRefId,
					targetKey: 'memberComments',
					modifier: 1,
				});
				break;
		}

		if (!result) throw new InternalServerErrorException(Message.CREATE_FAILED);
		return result;
	}

	public async updateComment(memberId: ObjectId, input: CommentUpdate): Promise<Comment> {
		const { _id, commentContent, commentStatus } = input;
		const update: T = { updatedAt: new Date() };
		if (commentContent !== undefined) update.commentContent = commentContent;
		if (commentStatus !== undefined) update.commentStatus = commentStatus;

		console.log('CommentService.updateComment - input:', {
			memberId: String(memberId),
			_id: String(_id),
			hasContent: commentContent !== undefined,
			hasStatus: commentStatus !== undefined,
		});

		const result = await this.commentModel.findOneAndUpdate(
			{
				_id: _id,
				memberId: memberId,
				commentStatus: CommentStatus.ACTIVE,
			},
			update,
			{
				new: true,
			},
		).exec();

		if (result) {
			console.log('CommentService.updateComment - updated:', {
				_id: String(result._id),
				commentStatus: result.commentStatus,
				updatedAt: result.updatedAt,
			});
		}

		if (!result) throw new InternalServerErrorException(Message.UPDATE_FAILED);
		return result;
	}

	/** Faqat comment yozgan member o‘z commentini o‘chira oladi (soft delete) */
	public async removeComment(memberId: ObjectId, commentId: ObjectId): Promise<Comment> {
		console.log('CommentService.removeComment - request:', {
			memberId: String(memberId),
			commentId: String(commentId),
		});

		const comment = await this.commentModel
			.findOne({ _id: commentId, memberId: memberId, commentStatus: CommentStatus.ACTIVE })
			.lean()
			.exec();
		if (!comment) throw new InternalServerErrorException(Message.REMOVE_FAILED);

		const result = await this.commentModel
			.findByIdAndUpdate(
				{ _id: commentId, memberId: memberId },
				{ commentStatus: CommentStatus.DELETE },
				{ new: true },
			)
			.exec();

		if (result) {
			console.log('CommentService.removeComment - removed (soft):', {
				_id: String(result._id),
				commentStatus: result.commentStatus,
			});
		}

		if (!result) throw new InternalServerErrorException(Message.REMOVE_FAILED);

		switch (comment.commentGroup) {
			case CommentGroup.WATCH:
				await this.watchService.watchStatusEditor({
					_id: comment.commentRefId,
					targetKey: 'watchComments',
					modifier: -1,
				});
				break;
			case CommentGroup.ARTICLE:
				await this.boardArticleService.boardArticleStatusEditor({
					_id: comment.commentRefId,
					targetKey: 'articleComments',
					modifier: -1,
				});
				break;
			case CommentGroup.MEMBER:
				await this.memberService.memberStatusEditor({
					_id: comment.commentRefId,
					targetKey: 'memberComments',
					modifier: -1,
				});
				break;
		}
		return result;
	}

	public async getComments(memberId: ObjectId, input: CommentsInquiry): Promise<Comments> {
		const { commentRefId } = input.search;
		const match: T = { commentRefId: commentRefId, commentStatus: CommentStatus.ACTIVE };
		const sort: T = { [input?.sort ?? 'createdAt']: input?.direction ?? Direction.DESC };

		const result: Comments[] = await this.commentModel
			.aggregate([
				{ $match: match },
				{ $sort: sort },
				{
					$facet: {
						list: [
							{ $skip: (input.page - 1) * input.limit },
							{ $limit: input.limit },
							// meLiked
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

	public async removeCommentByAdmin(commentId: ObjectId): Promise<Comment> {
		const search: T = {
			_id: commentId,
			commentStatus: CommentStatus.DELETE,
		};

		const result = await this.commentModel.findOneAndDelete(search).exec();

		if (!result) throw new InternalServerErrorException(Message.REMOVE_FAILED);

		return result;
	}
}
